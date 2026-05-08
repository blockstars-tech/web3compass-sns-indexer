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
| `content_pointer` | write (via `ContentPointerService.syncFromDns`) | Mutable-pointer state for `arweave-ns` rows once `PointerKind.ARWEAVE` ships in upstream. |

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
| `cid` | IPFS CID or Arweave transaction id, decoded from the record. |
| `contentType` | `'ipfs-ns'` or `'arweave-ns'`. |
| `setupTxHash` | The Solana signature of the registration tx, **base58 ~88 chars** (column is `varchar`, fits). |
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
| `SNS_REGISTER` | The Solana slot the most-recently-processed signature landed in. The signature itself goes in a new column `lastMigratedCursor` (added by the upstream schema PR). | Updated by `sns-register.job`. |
| `SNS_RECORDS_V2_UPDATE` | Same shape, separate cursor for the SNS Records V2 program. | Updated by `sns-record-changes.job`. |
| `SNS_BACKFILL` | Page index of the `getProgramAccounts` pagination. `isMigrated = true` once all pages processed. | Updated by `sns-backfill.job`. |

## Address normalization

`src/providers/address-normalizer.ts`:

```ts
export function normalizeOwnerAddress(chain: ChainEnum, addr: string): string {
  if (!addr) return addr;
  if (chain === ChainEnum.SOLANA) return addr;  // base58, case-sensitive
  return addr.toLowerCase();                     // EVM
}
```

Always go through this helper. The upstream repo's existing
`getOwnerAddress` lowercases unconditionally; a follow-up PR there will
route owner-write paths through this normalizer so the EVM convention
keeps applying without breaking SNS.

## Schema bumps required (in `web3compassapi`, before this repo can run)

1. `ChainEnum` add value `SOLANA = 'solana'` + non-tx migration on
   the Postgres `chain_enum` type.
2. `MigrationTypeEnum` add `SNS_REGISTER`, `SNS_RECORDS_V2_UPDATE`,
   `SNS_BACKFILL`.
3. (Optional but recommended) Add `lastMigratedCursor: text NULL`
   column to `dns_migrations`.
4. (v1.1, conditional on downstream agreement) Add `PointerKind.ARWEAVE`
   to `pointer/content-pointer.entity.ts` and update
   `pointerKindFromContentType()`.

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
