# Operations

How to run the indexer, what RPC provider to use, how to coordinate
deploys with `web3compassapi`.

## Local development

```bash
# 1. Postgres (or skip if you're pointing at an existing instance)
docker compose up -d postgres

# 2. Make sure web3compassapi has provisioned the schema against this DB
#    cd ../web3compassapi && yarn start   # boots and runs migrations
#    Stop it once migrations have applied.

# 3. Boot the indexer
cd ../web3compass-sns-indexer
cp .env.example .env  # fill in DB + Solana RPC
yarn install
yarn dev
```

The service boots in **application-context** mode (no HTTP). All work
runs from cron jobs.

## Production deploy ordering

This repo runs with `migrationsRun: false`. When a schema change is
required for SNS:

1. **Land the migration in `web3compassapi` first.** Open a PR there.
   The shipped pattern for enum additions (see
   `AddSnsSupport1777881600000`) extends the enum via
   `RENAME TYPE → CREATE TYPE → ALTER COLUMN TYPE → DROP _old`, which
   runs inside a single transaction. Only resort to `transaction =
   false` + `ALTER TYPE … ADD VALUE` if a future change cannot be
   expressed as a column-recast.
2. **Deploy `web3compassapi`.** Wait for the migration to apply.
3. **Sync entity files in this repo.** Copy the changed entities from
   `web3compassapi` byte-for-byte (`yarn check:entities` enforces exact
   match). Open a PR titled
   `chore(entities): sync from web3compassapi @ <sha>`.
4. **Deploy this repo.** Now safe.

If you reverse the order, this repo will boot with TypeORM thinking the
schema is wrong (entity has new column → DB doesn't), and either
silently skip or crash depending on the change.

## RPC provider choice

| Provider | Free tier | Backfill performance | SNS-aware tooling | Recommended for |
|---|---|---|---|---|
| **Helius** | yes | best (95% faster `getProgramAccounts` than typical) | yes (Enhanced Transactions parser) | **Default. Backfill runs here.** |
| **Alchemy Solana** | yes | improved post-DexterLabs acquisition | no | Live polling if you want vendor consolidation with EVM |
| **QuickNode** | yes | competitive | partial | Backup option |
| **Public RPCs** (api.mainnet-beta.solana.com) | yes | will rate-limit within minutes | no | Local dev smoke-tests only |

The indexer code is provider-agnostic — `Connection` from
`@solana/web3.js` is constructed in `solana.service.ts` from a single
`SOLANA_RPC_URL` env var. Swap providers by updating `.env` and
restarting.

## Cron cadences

| Job | Cadence | Notes |
|---|---|---|
| `sns-register.job` | every 1 min | Walks signatures on Bonfida registrar program. Light. |
| `sns-record-changes.job` | every 1 min | Walks signatures on SNS Records V2 program. Resolves content **inline** on the same pass (no flag-and-defer). |
| `sns-reconcile.job` | every 30s | Drains rows where `cid IS NULL`. Up to 4 RPC reads per row; concurrency-bounded by `SNS_RESOLVE_CONCURRENCY` and the global token-bucket throttle. |
| `sns-backfill.job` | every 2 min | Incremental enumeration of all `.sol` (256 partitions, one or more processed per tick). Double-gated by `ENABLE_SNS_CRONS=true` AND `SNS_BACKFILL_ENABLED=true`. Idle on completion. |

All cron decorators register on boot, but they are **gated by
`ENABLE_SNS_CRONS`** — with the gate off (the default in `.env.example`)
every tick is a no-op. Set `ENABLE_SNS_CRONS=true` once smoke runs are
green. The bootstrap log line states the active mode explicitly.

## Watching logs

The indexer logs Pino + ECS format. Useful greps:

```bash
# Cursor advance lines
... | jq 'select(.msg | test("cursor"))'

# Failed RPC calls
... | jq 'select(.level >= 50)'

# Per-domain reconciliation
... | jq 'select(.msg | test("reconcile"))'
```

## RPC budget — what to expect

**Backfill (incremental cron):** at default settings (2 partitions/tick,
50-key batches, every 2 min), one tick costs roughly 2 `getProgramAccounts`
calls (one per partition, payloads ~100KB each) plus ~120
`getMultipleAccountsInfo` calls (3000 accounts ÷ 50 batch size × 2
partitions). Total run: 256 partitions ÷ 2 = 128 ticks × 2 min ≈
**4 hours best case on free RPC, 8–12h realistic** because
`getProgramAccounts` is heavy and competes with the other jobs for
the CU/s budget. The retry helper patiently waits up to ~14 minutes
per partition before treating it as failed; held-cursor invariant
keeps state correct. Paid tier (Helius Developer+, Alchemy Growth+):
raise `SNS_BACKFILL_PARTITIONS_PER_TICK` to 16–32 for ~30 min runs.

Steady-state polling:
- Register + record-changes: 1 cursor-walk RPC per minute (paged up to
  `MAX_PAGES_PER_TICK=5`), plus 1 `getParsedTransaction` per new
  signature. Idle programs cost essentially zero.
- Reconcile: up to 4 RPC reads per row drained from `cid IS NULL`,
  throttled by `SNS_RESOLVE_CONCURRENCY` (default 5) and the global
  `SOLANA_RPC_MAX_RPS` token bucket (default 10).
- Backfill (post-completion): no RPC, fast no-op once
  `SNS_BACKFILL.isMigrated=true`.

For a half-million-row dataset on a paid mid-tier plan, the indexer
runs comfortably under quota in steady state. Backfill is what eats
the daily budget — run it once and move on.

## Troubleshooting

Common failure modes and how to read them in the logs:

- **Rate limit (HTTP 429 / `Too Many Requests`)** — `UtilsProvider.retryWithExponentialBackoff` retries; if it bubbles up, drop `SOLANA_RPC_MAX_RPS` or upgrade the plan.
- **Archival data missing** — `getParsedTransaction` returning `null` for old signatures means the RPC dropped pre-finalized history; switch to an archival-capable provider or seed cursors closer to current head.
- **Parse errors** — `SyntaxError: Unexpected token` from a JSON-RPC reply: transient, the held-cursor invariant replays the tick.
- **ROA mismatch on V2 records** — logged at `debug`; treated as missing, falls through to V1.
- **Database issues** — `relation "dns" does not exist` means the `web3compassapi` migration hasn't applied yet (deploy ordering, ADR 0002).
