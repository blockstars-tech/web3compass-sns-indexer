# SNS indexing — end-to-end overview

> Read this if you already understand how `web3compassapi` indexes ENS /
> BNB / Tomi on EVM and need the equivalent mental model for SNS
> (Solana Name Service). This doc maps SNS one-to-one against the EVM
> flow and explains exactly what happens when you `yarn dev`.

---

## 1. SNS in 60 seconds

| Concept | EVM (ENS) | Solana (SNS) |
|---|---|---|
| What is a domain? | A `bytes32 namehash` mapped through the ENS Registry contract | A Solana **account** owned by the SPL Name Service program. Its address is a PDA derived from `hash(name) + parentName + class`. |
| Who issues new domains? | The ETHRegistrarController contract (mints an ERC-721 to the buyer) | The Bonfida Name Auctioning / Registrar program, which CPIs into SPL Name Service to create the account |
| Where does content live? | One field (`contenthash`) on the resolver contract, set per-name | Up to four **child PDAs** off the domain account: V2/V1 × IPFS/ARWV |
| How do you detect changes? | Subscribe to typed events (`NameRegistered`, `ContenthashChanged`, …) | **No events.** You poll `getSignaturesForAddress(programId)` and parse instructions yourself |
| Cursor | Block number | Solana **slot** (the order-of-the-block analogue) |
| Backfill of history | `getPastEvents(fromBlock, toBlock)` block-walk | One-shot `getProgramAccounts(SPL_NS, parent=.sol_root)` snapshot |
| Owner address | EVM hex (case-insensitive — lowercased everywhere) | Solana base58 (**case-sensitive — never lowercased**) |

That last row is load-bearing: lowercasing a Solana address changes its
identity and breaks signature verification. The vendored
`address-normalizer.ts` has the chain-aware rule; nothing else should
touch case.

---

## 2. The two key Solana programs

```
SPL Name Service program     namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX
  └── Hosts every domain account, including all `.sol`. Issues
      Create / Update / Transfer / Delete instructions on name records.

SNS Records V2 program       HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ
  └── Newer record format (SNS-IP-3) with Right-of-Association (ROA)
      signatures proving the data was set by the *current* owner.

Bonfida Name Registrar       jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR
  └── TLD authority. CPIs into SPL NS to mint new top-level `.sol`.

`.sol` TLD root account      58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx
  └── Parent of every top-level `.sol`. We filter Create instructions
      on `parentName == this` to ignore subdomains and unrelated
      name-service uses.
```

V1 vs V2 records:
- **V1** — legacy. Record account named `\x01<RECORD>.<domain>.sol`,
  child of the domain. No authentication of the data.
- **V2** — newer. Lives under SNS Records V2. ROA signature proves the
  data was set by the *current* owner; staleness invalidates it on
  transfer.

We resolve **V2 first, V1 as fallback**, separately for IPFS and
Arweave. Order: `V2-IPFS → V1-IPFS → V2-ARWV → V1-ARWV → none`. A V2
record whose ROA fails verification is treated as **missing**, falling
through to the next step.

---

## 3. Full lifecycle of one `.sol` domain

The numbered events below are the same events EVM jobs handle, just
sourced from instruction parsing instead of typed event logs.

### 3.1 Registration — "a new `.sol` exists"

**EVM analogue:** `dns-eth.job` calling `getAndMigrate` on a block
range, scanning `NameRegistered` events.

**SNS:** `sns-register.job` (cron, every 1 min)

1. Read the cursor from `dns_migrations` row of type `SNS_REGISTER`
   (a Solana **slot**, stored in `lastMigratedBlockNumber`).
2. Walk `getSignaturesForAddress(BONFIDA_NAME_REGISTRAR_PROGRAM_ID,
   { until: seedSig })` newest-to-oldest, paginated, capped at
   `MAX_PAGES_PER_TICK=5`. Filter to `slot >= lastSlot`. (Cold start —
   `lastSlot=0` — takes a single page so we don't enumerate years of
   history; that's backfill's job.)
3. For each signature: `getParsedTransaction(sig)`, walk top-level +
   inner CPI instructions, classify each instruction as an SPL NS
   `Create` whose `parentName == SOL_TLD_ROOT`.
4. For each match, extract:
   - `domainPubkey` — the new account (used as `dns.node`).
   - `ownerPubkey` — the registry owner at registration (raw base58).
5. `reverseLookup(domainPubkey)` → bare name. Build `name = "<bare>.sol"`.
6. **Race-safe upsert** by name (`INSERT ... ON CONFLICT DO NOTHING`).
   The `record-changes` job and the `register` job can both observe
   "row missing" simultaneously and try to insert; the conflict clause
   guarantees one wins cleanly.
7. After all sigs in the batch are processed (oldest-first so retries
   are safe), save the cursor to the highest slot processed. **If any
   sig errored, hold the cursor at the lowest failing slot** so the
   next tick replays the failure — this is the "cursor must not advance
   past errors" invariant.

What's written: `name`, `node`, `chain='solana'`, `main='sol'`,
`ownerAddress`, `address` (= owner), `setupTxHash` = the registration
sig. **No `cid` yet** — that's the queue key the reconcile job uses.

### 3.2 First-time content resolution — "fill in the cid"

**EVM analogue:** `DnsEthJob` does this **inline** at registration. Its
`getAndMigrate` walks block events, and inside `getEns` it calls
`ensService.getContentHash(name)` immediately for each newly-discovered
ENS — so on EVM, registration discovery + first-time content fetch are
one atomic pass.

> Side note — what `dns-pending.job` actually is, since the name is
> tempting: it's a **separate retry path** for records that arrived
> from a different source than a NameRegistered event. The most common
> trigger is a `ContenthashChanged` event landing for a node we don't
> yet have a DNS row for; the handler pushes a pending record (owner
> address + node hash + tx) and `DnsPendingJob` later runs reverse-
> lookup (`ensService.nameLookup`) or subgraph lookup to recover the
> human-readable name. It is NOT the EVM equivalent of SNS reconcile.

**SNS splits this into a separate job — `sns-reconcile.job`**
(cron, every 30s). Why split: on Solana, resolving content is a 4-step
RPC chain (V2/V1 × IPFS/ARWV) and reverse-lookup costs another RPC.
Doing all that inline inside the signature walk would couple discovery
RPC budget to resolution RPC budget — a slow content read would block
the cursor from advancing and we'd miss new registrations. So SNS
inserts the skeleton row first (cheap, idempotent), and reconcile
drains the queue on its own cadence.

1. `findUnresolved('solana', 100)` — selects rows where
   `chain=solana AND cid IS NULL AND (is_fetch_failed != true)`. This
   is the first-time-resolution queue. Once a row has a CID it leaves
   the queue forever; later content changes are picked up by record-
   changes (see 3.3).
2. For each row, `PromisePool.withConcurrency(SNS_RESOLVE_CONCURRENCY)`
   calls `snsService.resolveContent(bareName)` — runs the
   V2-IPFS → V1-IPFS → V2-ARWV → V1-ARWV chain.
3. Apply the result via `applyResolution` (the shared state machine):
   - **Hit, new cid** → write `cid`, `contentType`, reset retry
     counters, `ipfsProcessed=false` (this hands the row to the downstream content-indexer,
     which queues it for indexing). Write `dns_settings` audit row.
     Call `contentPointerService.syncFromDns` (see note below).
   - **Hit, same cid** → refresh status flags only. No audit row, no
     pointer sync (state didn't change).
   - **Miss with no prior cid** → most common case: a domain registered
     but the owner hasn't set any IPFS / Arweave record yet. Increment
     `ipfsFetchAttempt`; once it hits `MAX_IPFS_FETCH_RETRY_ATTEMPTS`
     (3), flip `isFetchFailed=true` and the row drops out of the
     reconcile queue (the `findUnresolved` filter excludes it). The
     row **self-heals automatically** the moment record-changes sees
     a V2 write for it (the hit path resets `isFetchFailed=false`),
     OR an admin clears the flag manually.
   - **Miss with prior cid** → rare but real: the owner deleted their
     record on-chain. Only the record-changes job ever lands here
     (reconcile drains `cid IS NULL`, so by definition reconcile never
     sees a row that previously had a cid). Run `handleCidChange` to
     detach from the old CID's processing group, clear `cid` and
     `contentType`, write a `dns_settings` audit row noting the change,
     and delete the `content_pointer` row if one existed (only mutable
     kinds had one).

> **About `syncFromDns`:** the `content_pointer` system was added to
> track **mutable** content kinds — IPNS, Swarm-feed, DNSLink, TON-DNS
> — where the pointer value (e.g. an IPNS k51… key) resolves to a
> different anchor (CID) over time and the indexer needs to re-resolve
> on a schedule. **IPFS itself is immutable**: a CID *is* the content
> address, so there is no pointer row to maintain — `dns.cid` already
> holds the anchor. So for `contentType='ipfs-ns'`, `syncFromDns`
> short-circuits (deletes any stale row, which for an ipfs-ns dns row
> means a no-op because no pointer was ever written). For `ipns-ns` /
> `swarm-ns` / `dnslink`, it upserts the pointer row whose
> resolution + scheduling is owned by the downstream content-indexer.

This is exactly the EVM contract — `applyResolution` is the SNS port
of the body of `updateEnsContent` / `updateUnsContent` /
`updateDnsContentHash` from `web3compassapi/src/modules/dns/dns.service.ts`.
The same writes happen in the same order so downstream readers see one
shape across chains.

### 3.3 Content changes after first resolve — "the user updated their site"

**EVM analogue:** primarily `UpdateEnsJob` (`update.ens.job.ts`, every
~55s) — its `updateEnsContentFromResolver` paginates through every
resolver address tracked in `ens_resolvers` and pulls the
`ContenthashChanged` events from each, calling `updateEnsContent` per
event. (The canonical ENS resolver's events are also caught by
`DnsEthJob`'s `getEthContentChanges`; `UpdateEnsJob` is the dedicated
path for **all** custom resolvers a domain may have opted into.)
For BNB / Tomi the equivalent is `UpdateContenthashJob`
(`update.conent-hash.job.ts`).

**SNS:** `sns-record-changes.job` (cron, every 1 min)

1. Read the cursor from `dns_migrations` row of type
   `SNS_RECORDS_V2_UPDATE`.
2. Walk `getSignaturesForAddress(SNS_RECORDS_V2_PROGRAM_ID)` newest-to-
   oldest since the cursor. Same paging + same boundary refilter as
   register.
3. For each sig: `getParsedTransaction`, walk top-level + inner CPIs,
   keep instructions on the V2 program. Extract `accounts[4]` — the
   Bonfida SDK uses the same key layout across all 8 V2 instruction
   tags, so account-index 4 is the `domain` PDA in every case.
4. For each touched domain: `findByNode(domain.toBase58())`. If the
   row exists, update `setupTxHash` to the V2 sig and resolve content
   **inline** (same `resolveContent` chain, same `applyResolution`
   state machine as reconcile). If the row doesn't exist (record-
   changes saw a domain before register did), reverse-lookup + race-
   safe upsert, then resolve.
5. Save the slot cursor (held at the lowest failing slot if any sig
   errored).

**Why inline (not flag-and-let-reconcile-do-it):** the EVM
`updateEnsContent` jobs detect *and* resolve in one pass. Splitting
them on SNS would also need a queue flag, and the only candidate
column (`needs_reindex`) is reserved for the admin manual-trigger path
used by the downstream content-indexer. Inline preserves the EVM contract.

**v1 limitation:** only V2 records are walked. V1 record edits and
ownership transfers (which would need a walk of SPL Name Service
signatures) are deferred to v1.1. The Bonfida resolution chain prefers
V2 over V1, so V2 changes always supersede V1 — V1-only churn is rare
on modern domains.

### 3.4 The pre-existing 700k–1M `.sol` domains — "backfill via cron"

**EVM analogue:** `dns-eth.job` boot-time block walk from a historical
block forward.

**SNS:** `sns-backfill.job` (cron, every 2 min, env-gated by both
`ENABLE_SNS_CRONS=true` and `SNS_BACKFILL_ENABLED=true`).

Solana RPC has no native pagination on `getProgramAccounts`, so a v1
backfill that did one big call returned ~16–32MB and only worked on
paid endpoints. The current implementation **partitions the result
space using `memcmp` filters**:

  - **Filter 1** — `parentName == SOL_TLD_ROOT` at offset 0 (32 bytes)
    — restricts to top-level `.sol`, same as before.
  - **Filter 2** — `owner[0] == <prefix>` at offset 32 (1 byte) —
    restricts to one of 256 partitions.

Owner addresses are uniformly distributed in practice, so each
partition returns ~3000 accounts → small enough for free-tier RPC.

Per cron tick:

1. Read cursor (`SNS_BACKFILL.lastMigratedBlockNumber`, range
   `[0, 256]`). If `isMigrated=true`, no-op forever.
2. Process up to `SNS_BACKFILL_PARTITIONS_PER_TICK` partitions
   (default 4) starting from the cursor.
3. For each partition: enumerate domain pubkeys → reverse-lookup in
   batches of `SNS_BACKFILL_BATCH_SIZE` (default 50, one
   `getMultipleAccountsInfo` call per batch) → bulk insert skeleton
   rows via `INSERT ... ON CONFLICT DO NOTHING`.

   **Enumeration depends on provider:**
   - **Helius**: raw JSON-RPC call to `getProgramAccountsV2` with
     `paginationKey`. The SPL Name Service program has too many accounts
     for V1's one-shot result; Helius's index service returns
     "overloaded" without V2. Page size 10,000; usually one page per
     partition since each partition holds ~3k accounts.
   - **Other providers** (Alchemy, custom RPC): SDK `getProgramAccounts`
     one-shot with both `memcmp` filters and `dataSlice={offset:0,length:0}`.
     Free Alchemy can't sustain this under concurrent load — see RPC
     tier note below.
4. Save cursor after each successful partition. **On per-partition
   failure** (RPC 429, timeout, etc.): hold cursor, log the warning,
   break out — replay next tick. The `ON CONFLICT DO NOTHING` upserts
   make replay idempotent.
5. When cursor reaches 256, mark `isMigrated=true` and never run
   again until the row is reset.

The reconcile job picks up skeleton rows on its normal 30-second
schedule (`cid IS NULL`) — backfill and reconcile are loosely coupled
through that queue, so reconcile starts resolving content while
backfill is still enumerating.

**Time estimate at default settings (free tier):** 256 partitions ÷ 2
per tick = 128 ticks × 2 min = ~4 hours of wall clock if every tick
succeeds first time. **Budget 2-3× that on free Alchemy** — the heavy
`getProgramAccounts` call competes with the other live jobs for the
shared CU/s budget, and Alchemy 429s recover slowly. The retry helper
patiently waits up to ~14 min per partition before treating it as
failed; the held-cursor invariant means nothing gets lost. On paid
endpoints (Helius Developer+, Alchemy Growth+), raise
`SNS_BACKFILL_PARTITIONS_PER_TICK` to 16–32 for ~30 min runs.

**Re-running:** to start over, manually clear the row:
```sql
UPDATE dns_migrations
SET last_migrated_block_number = 0, is_migrated = false
WHERE type = 'SNS_BACKFILL';
```

---

## 4. The four jobs at a glance

| Job | Cron | Cron-gated by `ENABLE_SNS_CRONS` | Additional gate | Concurrency control | Cursor row (`dns_migrations.type`) |
|---|---|---|---|---|---|
| `sns-register.job` | `0 * * * * *` (every minute) | yes | — | `isJobRunning` guard + `PromisePool(SNS_TX_FETCH_CONCURRENCY)` | `SNS_REGISTER` (slot) |
| `sns-record-changes.job` | `0 * * * * *` (every minute) | yes | — | `isJobRunning` guard + `PromisePool(SNS_TX_FETCH_CONCURRENCY)` | `SNS_RECORDS_V2_UPDATE` (slot) |
| `sns-reconcile.job` | `*/30 * * * * *` (every 30s) | yes | — | `isJobRunning` guard + `PromisePool(SNS_RESOLVE_CONCURRENCY)` | none (queue selected by `cid IS NULL`) |
| `sns-backfill.job` | `0 */2 * * * *` (every 2 min) | yes | `SNS_BACKFILL_ENABLED=true` | `isJobRunning` guard + sequential partitions; `SNS_BACKFILL_PARTITIONS_PER_TICK` partitions per tick | `SNS_BACKFILL` (partition index, 0..256) |

All RPC calls also pass through the global token bucket
(`SOLANA_RPC_MAX_RPS`, default 10), which covers Bonfida SDK internals
that callsite-level retries can't see.

### 4.1 `sns-register.job` — what it does

> Discovers new `.sol` registrations.

- Walks signatures on the **Bonfida registrar program**.
- Parses SPL Name Service `Create` CPIs whose `parentName ==
  SOL_TLD_ROOT`.
- For each, reverse-looks up the new account → bare name → upsert a
  skeleton row with `cid=NULL`.
- Holds the cursor on errors so failures get retried; advances on
  clean batches. Idempotent against the boundary slot via name-keyed
  upserts.

What it does **not** do: resolve content. That's reconcile's job. The
register row leaves the job with `cid=NULL`.

### 4.2 `sns-record-changes.job` — what it does

> Re-resolves content when V2 records change.

- Walks signatures on the **SNS Records V2 program**.
- For each touched domain, looks up the dns row and resolves content
  **in the same pass** (mirrors EVM `updateEnsContent`).
- Stamps `setupTxHash` with the V2 record-write sig (so the audit row
  in `dns_settings` references the actual content tx, not the registration
  tx).
- Same `applyResolution` state machine as reconcile — handles cid-
  change cleanup, retry counters, audit row, pointer sync.

If it sees a domain reconcile/register hasn't created yet (race), it
reverse-looks up + race-safe upserts before resolving.

### 4.3 `sns-reconcile.job` — what it does

> First-time content resolution for skeleton rows.

- Drains `chain=solana AND cid IS NULL AND NOT is_fetch_failed`,
  oldest-first.
- Runs the V2-IPFS → V1-IPFS → V2-ARWV → V1-ARWV chain per row.
- Same `applyResolution` writes as record-changes.

Once a row has a CID, **it leaves this job's queue forever**. Future
content changes are caught by record-changes, not by this job re-
flagging anything. This is the architectural decision that lets us
keep `needsReindex` reserved for the downstream content-indexer's admin path.

Per-tick log line summarizes resolution-source distribution:
`v2-ipfs=N v1-ipfs=N v2-arwv=N v1-arwv=N none=N` — useful for capacity
tuning.

### 4.4 `sns-backfill.job` — what it does

> Incremental enumeration of every existing `.sol`, free-tier-friendly.

- Cron, every 2 min. Double-gated: needs both `ENABLE_SNS_CRONS=true`
  and `SNS_BACKFILL_ENABLED=true`. Either flag off → no-op.
- Partitions the result space using a second `memcmp` filter on
  `owner[0]` (offset 32 in the account data). 256 partitions × ~3000
  accounts each ≈ ~700k–1M total domains, but no single RPC payload
  is ever more than a few hundred KB.
- Per tick: enumerates `SNS_BACKFILL_PARTITIONS_PER_TICK` partitions
  (default 4), reverse-lookups them in `SNS_BACKFILL_BATCH_SIZE`
  batches (default 50), bulk-upserts skeleton rows. Saves cursor after
  each successful partition.
- Held-cursor invariant on partition failure (cursor stays at the
  failing partition; replays next tick). Idempotent name-keyed upserts
  cover replay.
- Refuses to run twice — once `isMigrated=true` is set on the
  `SNS_BACKFILL` row at partition 256, future ticks no-op until the
  row is manually reset.

---

## 5. What happens when you `yarn dev` (bootstrap)

```
yarn dev
   │
   ▼
src/main.ts
   ├─ NestFactory.createApplicationContext(AppModule)
   │       (no HTTP server — this is a worker)
   │
   ├─ ConfigModule loads .env  → ApiConfigService
   │
   ├─ TypeOrmModule.forRootAsync (migrationsRun: false)
   │       Connects to the same Postgres web3compassapi owns.
   │       Fails fast if the schema isn't already applied.
   │
   ├─ ScheduleModule.forRoot()
   │       Registers @Cron decorators with @nestjs/schedule.
   │
   ├─ SnsModule providers instantiated
   │       SnsRegisterJob       ← @Cron('0 * * * * *',  …)
   │       SnsRecordChangesJob  ← @Cron('0 * * * * *',  …)
   │       SnsReconcileJob      ← @Cron('*/30 * * * * *', …)
   │       SnsBackfillJob       ← @Cron('0 */2 * * * *', …)
   │
   ├─ Bootstrap log lines:
   │   "web3compass-sns-indexer started (application context, no HTTP)"
   │   "Cron jobs ENABLED — register (1m), record-changes (1m),
   │      reconcile (30s), backfill ON|OFF"
   │                              ← if ENABLE_SNS_CRONS=true
   │   OR
   │   "Cron jobs DISABLED (ENABLE_SNS_CRONS=false). Crons tick on
   │      schedule but each is a no-op…"
   │                              ← if ENABLE_SNS_CRONS=false
   │
   └─ process stays alive until SIGINT / SIGTERM
```

After bootstrap, **the cron schedule drives all work**. There is no
HTTP server, no one-shot startup walk, no event-bus listener. With
`ENABLE_SNS_CRONS=true`, each tick:

- The **register** job (every 1 min) walks new signatures on the
  Bonfida program, upserts new skeleton rows.
- The **record-changes** job (every 1 min) walks new V2 sigs,
  resolves content inline for affected rows.
- The **reconcile** job (every 30s) drains skeleton rows that don't
  have a CID yet.
- The **backfill** job (every 2 min, additionally gated by
  `SNS_BACKFILL_ENABLED=true`) processes a few partitions of the
  ~256-partition full enumeration of all `.sol` domains.

With `ENABLE_SNS_CRONS=false` (the default in `.env.example`), the same
ticks fire but each job's gate short-circuits before any RPC call.
The bootstrap log line tells you which mode you're in.

### When all four jobs run together — what's safe and why

You don't need to sequence the jobs ("backfill first, then register",
or similar). The system tolerates concurrent execution because every
write is idempotent and every read is independent. The interesting
interactions:

| Race | Resolution |
|---|---|
| `record-changes` sees a V2 write for a domain register / backfill haven't yet inserted | The job has an "unknown domain" branch: reverse-lookup → `INSERT ... ON CONFLICT DO NOTHING` (race-safe), then resolve content inline. Row created and content filled in one pass. |
| `register` and `record-changes` both observe a missing row simultaneously | Both attempt insert; the unique `name` index conflict makes one win cleanly. Whichever lost re-fetches the winning row and proceeds. |
| `backfill` enumerates a domain register / record-changes already inserted | `INSERT ... ON CONFLICT DO NOTHING` no-ops. Backfill never overwrites richer rows. |
| `reconcile` runs while backfill is still inserting skeletons | Reconcile drains by `cid IS NULL` regardless of source. New skeletons keep flowing into its queue. |
| Backfill enumerates a domain in the same partition tick that record-changes also processes | Either order is safe: record-changes will hit the already-inserted skeleton (find by node) OR the upsert race resolves to one writer; the other re-fetches. |

So the run order on a fresh deploy is just: turn `ENABLE_SNS_CRONS=true`
and (if you want historical domains) `SNS_BACKFILL_ENABLED=true`, then
`yarn dev`. Reconcile starts resolving content for newly registered
and backfilled domains in parallel.

---

## 6. End-to-end happy paths

### 6.1 First-time deploy with backfill

```
1. Provision Postgres schema    (web3compassapi runs migrations)
2. Configure .env               (DB creds, RPC creds,
                                 ENABLE_SNS_CRONS=true,
                                 SNS_BACKFILL_ENABLED=true)
3. yarn dev                     (one process, four cron jobs)
                                 │
                                 ├─ register: from now forward, new domains
                                 │            → skeleton rows
                                 ├─ record-changes: from now forward,
                                 │                  V2 record updates → inline resolve
                                 ├─ backfill: every 2 min, processes a few
                                 │            of 256 partitions until done
                                 │            (~4-12h on free tier defaults,
                                 │             ~30 min on paid RPC)
                                 └─ reconcile: every 30s, drains every
                                              skeleton (from register OR
                                              backfill) and writes cid

4. Watch logs.
   - "SNS backfill: partition 17 done (accounts=2840 attempted=2812
      noReverse=28)" — backfill progress
   - "SNS reconcile: v2-ipfs=N v1-ipfs=N v2-arwv=N v1-arwv=N none=N"
      — resolution distribution
   - "SNS backfill: COMPLETE — all 256 partitions processed" — done

5. Once backfill is COMPLETE, you can leave SNS_BACKFILL_ENABLED=true;
   subsequent ticks short-circuit (no RPC cost).
```

**Free-tier note:** the default partition cadence is intentionally
gentle. If you see frequent 429s in logs, drop
`SNS_BACKFILL_PARTITIONS_PER_TICK` to `2` or even `1`. The cursor is
durable — slowness extends wall-clock time, not correctness.

### 6.2 Fresh user registers `vitalik.sol` while the indexer is running

```
T+0s   Vitalik signs Bonfida registrar tx → confirmed on-chain
T+45s  sns-register.job tick:
         walk getSignaturesForAddress(BONFIDA_REGISTRAR) → 1 new sig
         getParsedTransaction → 1 SPL NS Create with parent=.sol root
         reverseLookup(newAccount) → "vitalik"
         INSERT INTO dns ON CONFLICT DO NOTHING
           (name='vitalik.sol', node=…, owner=…, setupTxHash=…)
         save SNS_REGISTER cursor → newSlot
T+55s  sns-reconcile.job tick:
         findUnresolved → vitalik.sol (cid IS NULL)
         resolveContent('vitalik') → V2-IPFS hit, cid=Qm…
         applyResolution → write cid + contentType, ipfsProcessed=false,
           audit row, syncFromDns
T+1m   row is fully populated; the downstream content-indexer picks it up via
         ipfsProcessed=false on its own schedule
```

### 6.3 Vitalik updates the IPFS record on `vitalik.sol`

```
T+0s   Vitalik signs SNS V2 editRecord tx → confirmed on-chain
T+50s  sns-record-changes.job tick:
         walk getSignaturesForAddress(SNS_RECORDS_V2) → 1 new sig
         getParsedTransaction → V2 instruction touching vitalik's
                                 domain pubkey (accounts[4])
         findByNode → existing dns row
         row.setupTxHash = newSig
         resolveContent('vitalik') → V2-IPFS hit, cid=Qm…NEW
         applyResolution → handleCidChange(oldCid), write new cid,
           reset counters, ipfsProcessed=false, audit row,
           syncFromDns (deletes any pointer for ipfs-ns since IPFS is
                        immutable; upserts a pointer row for mutable
                        kinds: ipns-ns / swarm-ns / dnslink)
         save SNS_RECORDS_V2_UPDATE cursor → newSlot
```

### 6.4 RPC blip during a tick

```
T+0s   Helius returns 503 mid-tick on getParsedTransaction(sigB)
       UtilsProvider.retryWithExponentialBackoff retries → still fails
       processSignature(sigB) throws → PromisePool collects the error
       ordered = [sigA, sigB, sigC] (sigA succeeded, sigC succeeded)
       errors = [{ item: sigB }]
       safeSlot = sigB.slot   ← held at the lowest failing slot
       saveSnsRegisterMigration({ lastBlock: sigB.slot })
T+1m   next tick: walker re-fetches sigs >= sigB.slot, idempotent
       upserts re-process sigA + sigB + sigC; sigB now succeeds
```

This is the "cursor must not advance past errors" invariant. Combined
with idempotent name-keyed upserts, replays are correct even though
they re-process some signatures.

---

## 7. Where each writeable column comes from

| Column | Set by | Value |
|---|---|---|
| `name` | register / record-changes / backfill | `"<bare>.sol"` |
| `node` | register / record-changes / backfill | base58 of the domain account pubkey |
| `cid` | reconcile / record-changes (via `applyResolution`) | IPFS CID or Arweave tx id |
| `contentType` | reconcile / record-changes | `'ipfs-ns'` or `'arweave-ns'` |
| `setupTxHash` | register on insert; record-changes overwrites with the V2 sig | Solana base58 signature (~88 chars) |
| `ownerAddress` | register / record-changes | base58 wallet pubkey, **never lowercased** |
| `address` | register / record-changes | same as `ownerAddress` for v1 |
| `chain` | all | `'solana'` |
| `main` | all | `'sol'` |
| `expiresAt` | nothing | `NULL` — V1 SNS domains don't expire; V2 renewals exist but aren't tracked yet |
| `ensResolverId` | nothing | `NULL` — SNS has no resolver indirection |
| `ipfsProcessed` | applyResolution | `false` on cid-change (signal the downstream content-indexer uses to queue indexing); `true` on miss |
| `ipfsFetchStatus` | applyResolution | `0=SUCCESS` on hit; `1=FAILED` on miss |
| `ipfsFetchAttempt` | applyResolution | incremented on miss; reset on hit |
| `isFetchFailed` | applyResolution | `true` once miss-counter ≥ `MAX_IPFS_FETCH_RETRY_ATTEMPTS` |
| `needsReindex` | the downstream content-indexer admin only — **not by SNS jobs** | `true` triggers admin re-indexing |

---

## 8. Quick reference — running the project

```bash
# One-time setup
nvm use
yarn install
cp .env.example .env
$EDITOR .env
  # set DB creds, set SOLANA_RPC_API_KEY, set ENABLE_SNS_CRONS=true,
  # optionally SNS_BACKFILL_ENABLED=true (recommended for fresh deploys)

# Boot the worker (cron-driven, no HTTP)
yarn dev

# One-shot smoke runs without flipping ENABLE_SNS_CRONS (handy for
# debugging a single job without waiting for its cron tick):
yarn cli:once register
yarn cli:once record-changes
yarn cli:once reconcile

# Sanity checks
yarn typecheck
yarn lint
yarn test
yarn check:entities
```

The bootstrap log line tells you if cron jobs are enabled. If it
prints `Cron jobs DISABLED` and you expected work to happen, set
`ENABLE_SNS_CRONS=true` in `.env` and restart.

> **Backfill is now a cron job, not a CLI command.** It used to be
> `yarn cli:backfill`; that script has been removed in favor of
> setting `SNS_BACKFILL_ENABLED=true` and letting the cron drive it
> in the background.
