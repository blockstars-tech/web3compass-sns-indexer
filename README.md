# web3compass-sns-indexer

Solana Name Service (`.sol`) indexer for web3compass.

This service watches the SPL Name Service program and the SNS Records V2
program on Solana, and writes domain rows + content pointers (IPFS,
Arweave) into the web3compass Postgres database.

## What this is

- A NestJS worker that polls Solana RPC for new `.sol` registrations and
  record changes.
- A sibling indexer to the main web3compass API: same Postgres schema,
  same TypeORM entities, same job + cursor pattern.

## What this is not

- A standalone product with its own database.
- A content crawler (the website behind a CID is fetched by a separate
  service).
- A schema authority — migrations live in the main API.

## Quickstart

```bash
nvm use                       # Node 20
yarn install
cp .env.example .env          # fill in DB + Solana RPC + ENABLE_SNS_CRONS=true
yarn typecheck
yarn dev
```

The service boots in **application-context** mode (no HTTP server),
runs the SNS jobs on cron, and writes to the configured Postgres.

> The Postgres schema must already be provisioned against the same DB
> by the main web3compass API. This repo runs with
> `migrationsRun: false`.

### Important: cron jobs are disabled by default

Out of the box, `.env.example` ships `ENABLE_SNS_CRONS=false`. With that
setting, `yarn dev` boots cleanly but every cron tick is a no-op — the
indexer is idle. To actually index:

```bash
# .env
ENABLE_SNS_CRONS=true
```

Then `yarn dev`. The bootstrap log line will read
`Cron jobs ENABLED — register (1m), record-changes (1m), reconcile (30s)`.
For one-shot smoke runs without flipping the gate, use
`yarn cli:once <register|reconcile|record-changes|backfill>`.

## How it indexes

Three runtime paths, all polling-only:

1. **Discover new domains** — `sns-register.job` walks
   `getSignaturesForAddress(BONFIDA_NAME_REGISTRAR_PROGRAM_ID)` since the
   slot cursor, parses each tx for SPL Name Service `Create` instructions
   with `parentName == .sol TLD root`, reverse-looks up the new account
   to its bare name, and upserts a skeleton `dns` row (no `cid` yet).
2. **Detect record changes** — `sns-record-changes.job` walks the SNS
   Records V2 program signatures, finds the affected domain account in
   each instruction (account index 4), and **resolves content inline** —
   detecting the change and writing the new CID in the same pass, just
   like EVM's `updateEnsContent`. (V1 record / ownership-transfer walk
   on the SPL Name Service program is deferred to v1.1.)
3. **Resolve content for first-time rows** — `sns-reconcile.job` drains
   rows where `chain = solana AND cid IS NULL AND is_fetch_failed != true`
   and runs the V2-IPFS → V1-IPFS → V2-ARWV → V1-ARWV resolution chain,
   writing `cid` + `contentType` back. Once a row has a CID, future
   content changes are picked up by record-changes (not by this job).

Plus `sns-backfill.job` (cron, every 2 min) — incremental enumeration
of every existing `.sol` domain. Partitions the result space 256 ways
using a second `memcmp` filter on the owner address, so each
`getProgramAccounts` call stays small. Free-tier-friendly. Double-gated:
needs both `ENABLE_SNS_CRONS=true` and `SNS_BACKFILL_ENABLED=true`.

## Deploy

This service runs as a single long-lived container. No HTTP server, no
public ports, no DB migrations of its own.

### Prerequisites

1. **`web3compassapi` migrations applied first**, on the same database.
   The `AddSnsSupport1777881600000` migration adds `solana` to the
   `dns_chain_enum` and the SNS migration types — without it, this
   service will crash at startup.
2. **Solana RPC key** — production uses Alchemy paid (Growth+). Free-tier
   keys throttle the backfill and reconcile jobs heavily.
3. **Postgres credentials** for the same DB the api repo writes to.

### Build & run

```bash
docker build -t web3compass-sns-indexer .
docker run --env-file .env web3compass-sns-indexer
```

The image runs `node dist/main.js` as the `node` user.
`yarn build` produces `dist/main.js` from `tsconfig.build.json`.

### Required env vars (production)

| Var | Required | Notes |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | yes | Same DB as `web3compassapi` |
| `PG_SSL` | yes | `true` for managed Postgres |
| `SOLANA_RPC_PROVIDER` | yes | `alchemy` for prod |
| `SOLANA_RPC_API_KEY` | yes | Alchemy app key |
| `SOLANA_RPC_NETWORK` | yes | `mainnet` |
| `ENABLE_SNS_CRONS` | yes | `true` to actually index; `false` ships idle |
| `SNS_BACKFILL_ENABLED` | yes | `true` for first deploy; safe to leave on (no-op once complete) |
| `SOLANA_RPC_MAX_RPS` | recommended | `25` for moderate paid-Alchemy pace |
| `IPFS_GATEWAY_URL` | recommended | Defaults to `https://ipfs.io/ipfs/` |
| `LOG_LEVEL` | optional | `info` (default) |

See `.env.example` for the full list with tuning notes.

### Cron schedules (fixed in code)

| Job | Schedule | What it does |
|---|---|---|
| `sns-register` | every 1 min | Discovers new `.sol` registrations |
| `sns-record-changes` | every 1 min | Resolves content for V2-record-write events inline |
| `sns-reconcile` | every 30 sec | Drains `cid IS NULL` first-time-resolution queue |
| `sns-backfill` | every 2 min | Enumerates existing `.sol` domains until done |

### Healthcheck (no HTTP endpoint — query Postgres)

```sql
-- Liveness: cursors should advance over time
SELECT type, last_migrated_block_number, updated_at
FROM dns_migrations WHERE chain = 'solana';

-- Backfill progress: 256 = done
SELECT last_migrated_block_number, is_migrated
FROM dns_migrations WHERE type = 'SNS_BACKFILL';

-- Reconcile drain progress
SELECT
  COUNT(*) FILTER (WHERE cid IS NOT NULL) AS scraped,
  COUNT(*) FILTER (WHERE cid IS NULL AND is_fetch_failed = TRUE) AS exhausted,
  COUNT(*) FILTER (WHERE cid IS NULL AND is_fetch_failed IS NOT TRUE) AS in_queue
FROM dns WHERE chain = 'solana';
```

If `dns_migrations.updated_at` for any SNS row is more than ~10 minutes
stale and `ENABLE_SNS_CRONS=true`, the job is stuck. Check container
logs for `tick failed` or `signature failed` (rare under paid RPC).

### What you should NOT see in steady state

- `tick failed` more than once an hour → RPC issue worth investigating
- `reverse-lookup miss` looping on the same account every minute for
  >2 hours → known cosmetic warn (boundary-slot stuck until new V2
  activity); not data loss, won't crash anything
- Container restarts → check `LOG_LEVEL=debug` briefly to see which
  init step fails

### Resource sizing

512 MB RAM and 0.5 vCPU is plenty. The hot path is RPC I/O, not CPU.

## Project layout

| Path | What lives here |
|---|---|
| `src/modules/sns/` | SNS-specific module: jobs, parsers, the resolution chain. |
| `src/modules/dns/` | Vendored DNS entities and repositories. **Do not diverge.** |
| `src/modules/pointer/` | Vendored content-pointer module. |
| `src/modules/shared/` | RPC + Solana client wrappers, env config. |
| `scripts/check-entity-drift.ts` | Guard against entity drift vs upstream. |

## Status

`v0.1.0-dev`. Jobs (register, record-changes, reconcile, backfill) are
implemented and unit-tested. Live cursors are wired. Cron jobs are
gated by `ENABLE_SNS_CRONS` so a deploy can ship in idle mode and the
operator flips the switch when ready.

## License

MIT — see [`LICENSE`](./LICENSE).
