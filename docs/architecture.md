# Architecture

A small NestJS worker. Four cron jobs (register, record-changes,
reconcile, backfill), one shared service, one Solana RPC client.
Writes to the same Postgres database `web3compassapi` owns.

## Module map

```
src/
├── main.ts                    # bootstrap (application context, no HTTP)
├── app.module.ts              # wires together the modules below
│
├── modules/
│   ├── shared/                # cross-cutting: env config, Solana client
│   │   ├── shared.module.ts
│   │   └── services/
│   │       ├── api-config.service.ts    # env reader, fail-loud at boot
│   │       ├── solana.service.ts        # @solana/web3.js Connection wrapper
│   │       └── sns.service.ts           # high-level resolver: V2→V1, IPFS→ARWV
│   │
│   ├── dns/                   # vendored from web3compassapi
│   │   ├── dns.entity.ts
│   │   ├── dns-migration.entity.ts
│   │   ├── dns.repository.ts
│   │   ├── dns-migration.repository.ts  # extended locally with SNS helpers
│   │   └── cid-processing/
│   │       ├── cid-processing.entity.ts
│   │       └── cid-processing.repository.ts
│   │
│   ├── pointer/               # vendored from web3compassapi
│   │   ├── content-pointer.entity.ts
│   │   ├── content-pointer.repository.ts
│   │   ├── content-pointer.service.ts
│   │   └── pointer.module.ts
│   │
│   └── sns/                   # SNS-specific code (the new bit)
│       ├── sns.module.ts
│       ├── lib/
│       │   └── signature-walker.ts        # paginate getSignaturesForAddress
│       ├── parsers/
│       │   ├── sns-create-instruction.ts  # SPL NS Create classifier
│       │   └── sns-record-instruction.ts  # SNS Records V2 domain extractor
│       └── jobs/
│           ├── sns-register.job.ts        # cron: every 1 min
│           ├── sns-record-changes.job.ts  # cron: every 1 min, resolves inline
│           ├── sns-reconcile.job.ts       # cron: every 30s
│           ├── sns-reconcile.state.ts     # pure state machine (unit-tested)
│           └── sns-backfill.job.ts        # cron: every 2 min, double-gated
│                                          #       by SNS_BACKFILL_ENABLED
│
├── constants/                 # enums vendored from web3compassapi
├── strategies/                # snake naming, vendored
├── db/                        # TypeOrmExModule, vendored
└── providers/
    ├── utils.provider.ts      # slim subset of upstream helpers
    └── address-normalizer.ts  # chain-aware lowercase rule
```

## Data flow

### One domain, end-to-end

```
   Solana network
       │
       │  Bonfida registrar emits a Create CPI under SPL NS
       ▼
┌──────────────────────────────────────┐
│ sns-register.job  (every 1 min)      │
│   getSignaturesForAddress(           │
│     BONFIDA_NAME_REGISTRAR,          │
│     until=seedSig)                   │
│   parse top-level + inner CPIs       │
│   filter SPL NS Create + parentName  │
│       == SOL_TLD_ROOT                │
│   reverseLookup -> bare name         │
│   INSERT ... ON CONFLICT DO NOTHING  │
│     name, node, owner, setupTxHash   │
│   save SNS_REGISTER cursor (slot)    │
└──────────────┬───────────────────────┘
               │  row landed with cid=NULL
               ▼
┌──────────────────────────────────────┐
│ sns-reconcile.job (every 30s)        │
│   findUnresolved(solana, 100)        │
│     → cid IS NULL AND                │
│       NOT is_fetch_failed            │
│   resolveContent(): V2-IPFS,         │
│     V1-IPFS, V2-ARWV, V1-ARWV        │
│   applyResolution() → write          │
│     cid, contentType, audit row,     │
│     content_pointer                  │
└──────────────┬───────────────────────┘
               │
               ▼  steady state — row has cid
┌──────────────────────────────────────┐
│ sns-record-changes.job (every 1 min) │
│   getSignaturesForAddress(           │
│     SNS_RECORDS_V2)                  │
│   parse instructions, extract        │
│     accounts[4] = domain pubkey      │
│   findByNode → applyResolution       │
│     INLINE (resolve + write in       │
│     same pass; mirrors EVM           │
│     updateEnsContent)                │
│   save SNS_RECORDS_V2_UPDATE cursor  │
└──────────────────────────────────────┘
```

Three jobs, one shared write protocol. `sns-reconcile.state.ts`
(`applyResolution`) is the single state machine that both reconcile and
record-changes apply on a per-row basis — it owns `handleCidChange`,
`saveRow`, `createDnsSettings` (audit), and `syncFromDns`
(content-pointer reconcile). The pure-function shape lets unit tests
exercise every path with mocked side-effects.

`sns-backfill.job` (cron, every 2 min, double-gated by
`SNS_BACKFILL_ENABLED=true`) enumerates pre-existing `.sol` domains
incrementally. It partitions the result space using a second `memcmp`
filter on owner first byte (256 buckets), processing a few partitions
per tick and bulk-inserting skeleton rows that reconcile then fills in.
Cursor is durable, so a restart resumes cleanly. Free-tier-friendly.

## Shared-DB contract

Two repos share one Postgres:

- `web3compassapi` is the **schema authority**. Migrations live there.
  Boots with `migrationsRun: true`.
- `web3compass-sns-indexer` (this repo) reads and writes the same
  tables but **never runs migrations** (`migrationsRun: false`).

Entity files in this repo are vendored copies. CI guards against drift
via `yarn check:entities`. See
[`adr/0001-shared-db-with-web3compassapi.md`](./adr/0001-shared-db-with-web3compassapi.md)
and
[`adr/0002-no-migrations-in-this-repo.md`](./adr/0002-no-migrations-in-this-repo.md).

## What's not in the architecture (and why)

- **No HTTP server.** This is a worker. Bootstrapped via
  `NestFactory.createApplicationContext()`, not `NestFactory.create()`.
  Saves boot time, no port to expose, fewer attack surfaces. If we
  ever need a `/health` endpoint, we add it then.
- **No webhook listener, no WSS `programSubscribe`.** Polling only,
  per [`adr/0004-poll-only-no-webhooks-no-wss.md`](./adr/0004-poll-only-no-webhooks-no-wss.md).
- **No own DB, no own HTTP API, no event bus.** The SNS indexer
  writes directly to the shared `dns` table, exactly like the EVM
  indexers in `web3compassapi`.
