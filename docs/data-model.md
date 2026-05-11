# Data model

This service writes to the same Postgres database used by
`web3compassapi`. We do not own any of these tables — we read and
write them.

## Tables we use

| Table | Direction | What we put in it |
|---|---|---|
| `dns` | write | One row per `.sol` domain. `chain = 'solana'`, `main = 'sol'`. |
| `dns_migrations` | write | Cursor rows of type `SNS_REGISTER`, `SNS_RECORDS_V2_UPDATE`, `SNS_BACKFILL`. |
| `cid_processing` | write (via `handleCidChange` analogue) | CID dedup grouping when multiple `.sol` domains point at the same CID. |
| `content_pointer` | write (via `ContentPointerService.syncFromDns`) | Mutable-pointer state for `ipns-ns` rows (including IPFS slots whose payload is `ipns://<key>`). Resolution + ingestion run in the downstream content-indexer. |

## Tables we do NOT touch

`urls`, `dns_settings`, `ens_resolvers`, `dns_pending`, anything
auth/user-related. The entity files for `urls`, `dns_settings`,
`ens_resolvers` are vendored only because `DnsEntity` has relationship
declarations to them; we never insert/update those tables.

## What goes in each `dns` column for an SNS row

| Column | SNS value |
|---|---|
| `name` | `"foo.sol"` (lowercased — name strings are case-insensitive in SNS clients) |
| `node` | The SPL name-service account pubkey, **base58**. |
| `cid` | IPFS CID, IPNS key, or Arweave transaction id, decoded from the record. |
| `contentType` | `'ipfs-ns'`, `'ipns-ns'`, or `'arweave-ns'`. |
| `setupTxHash` | The Solana signature of the most recent registration or V2 record-write tx, **base58 ~88 chars** (column is `varchar`, fits). |
| `tokenId` | `null` (SNS has no NFT token-id model). |
| `ownerAddress` | Base58 wallet pubkey — **never lowercased**. |
| `address` | Same as `ownerAddress` at write time. |
| `main` | `'sol'`. |
| `chain` | `'solana'` (Postgres enum value, must exist before this repo writes). |
| `expiresAt` | `null` (V1 perpetual). |
| `ensResolverId` | `null` (SNS has no per-resolver indirection). |
| `ipfsProcessed` | `false` if `cid` is set (the downstream content-indexer will flip this); `true` if there's no content to fetch. |
| `cidProcessingId`, `isPrimary` | Reused as-is via `ContentPointerService.syncFromDns` — same semantics as ENS rows. |

## Cursor rows in `dns_migrations`

Each row is `(type, chain, lastMigratedBlockNumber, isMigrated)`.

| `type` | What `lastMigratedBlockNumber` holds | Notes |
|---|---|---|
| `SNS_REGISTER` | The Solana slot of the most-recently-processed signature. The next tick re-walks signatures with `slot >= lastSlot` and relies on name-keyed idempotent upserts to cover boundary-slot replays — no separate signature cursor column. | Updated by `sns-register.job`. |
| `SNS_RECORDS_V2_UPDATE` | Same shape, separate cursor for the SNS Records V2 program. | Updated by `sns-record-changes.job`. |
| `SNS_BACKFILL` | Partition index into the 256-bucket `getProgramAccounts` enumeration (range `[0, 256]`). `isMigrated = true` once all partitions processed. | Updated by `sns-backfill.job`. |

## Address normalization

`src/providers/address-normalizer.ts`:

```ts
export function normalizeOwnerAddress(chain: ChainEnum, addr: string): string {
  if (!addr) return addr;
  if (chain === ChainEnum.SOLANA) return addr;  // base58, case-sensitive
  return addr.toLowerCase();                     // EVM
}
```

The SNS jobs in this repo currently write Solana base58 directly via
`pubkey.toBase58()` (no caller for the helper yet), so the file
documents the canonical chain-aware rule even where it isn't yet wired
in. The upstream repo's existing `getOwnerAddress` lowercases
unconditionally; a follow-up PR there will route owner-write paths
through this normalizer so the EVM convention keeps applying without
breaking SNS.

## Schema bumps required (in `web3compassapi`, before this repo can run)

Already shipped in migration `AddSnsSupport1777881600000`:

1. `ChainEnum` adds value `SOLANA = 'solana'` — applied via the
   rename-type pattern (`RENAME TO _old` → `CREATE TYPE` → `ALTER COLUMN`
   → `DROP _old`), which runs inside a single transaction.
2. `MigrationTypeEnum` adds `SNS_REGISTER`, `SNS_RECORDS_V2_UPDATE`,
   `SNS_BACKFILL`.
3. `DnsTypeEnum` / `ens_resolvers_type_enum` adds `SNS = 'sns'`.

No `lastMigratedCursor` column — the indexer uses a slot-only cursor
with `>=` refilter and idempotent name-keyed upserts. Not shipped, not
needed.

## What the drift check enforces

`scripts/check-entity-drift.ts` (run by `yarn check:entities`)
diffs the following files against `web3compassapi` upstream:

- `src/modules/dns/dns.entity.ts`
- `src/modules/dns/dns-migration.entity.ts`
- `src/modules/dns/cid-processing/cid-processing.entity.ts`
- `src/modules/pointer/content-pointer.entity.ts`
- `src/modules/dns/url.entity.ts`
- `src/modules/dns/dns-settings.entity.ts`
- `src/modules/dns/ens-resolver.entity.ts`
- `src/modules/common/entities/abstract.entity.ts`
- `src/constants/chain.enum.ts`
- `src/constants/migration-type.enum.ts`

Diff strategy is exact-match. Whitespace and ordering matter. If
upstream changes something cosmetic, mirror it here verbatim.
