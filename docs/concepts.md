# SNS — concepts (the parts that matter for indexing)

A short primer for engineers new to Solana Name Service.

## SNS in three sentences

SNS is the Solana equivalent of ENS. A `.sol` domain is a Solana
account owned by the SPL Name Service program; the account's address
is derived from the name string. Content pointers (IPFS, Arweave, URL,
Shadow Drive) are stored in **child accounts** off the domain.

## Programs

| Program | ID | Purpose |
|---|---|---|
| SPL Name Service | `namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX` | Generic name registry. Hosts all `.sol` and their record children. |
| SNS Records V2 | `HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ` | Newer record format with ROA / staleness verification (SNS-IP-3). |
| `.sol` TLD root | `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx` | Parent name-record account; top-level `.sol` domains' `parentName` field points here. |

## How indexing differs from ENS

| Aspect | ENS (EVM) | SNS (Solana) |
|---|---|---|
| Events | Typed (`NameRegistered`, `ContenthashChanged`) | None — we parse instructions and account state |
| Cursor | Block number | Transaction signature (+ slot for human-readability) |
| Content pointer | One field on the resolver contract | Up to 4 child PDAs (V2/V1 × IPFS/ARWV) |
| Backfill | Block walk from genesis | One-shot `getProgramAccounts` snapshot |

## V1 vs V2 records

- **V1** — legacy. The record account's name is `\x01<RECORD>.<domain>.sol`,
  derived as a child of the domain's account. Owned by the parent's
  owner. **No authentication of the data.** Can become stale on
  transfer.
- **V2** — newer (SNS-IP-3). Lives under the SNS Records V2 program.
  Adds a header with content type, length, and a Right-of-Association
  (ROA) signature proving the data was set by the *current* owner.

For one record kind (e.g. IPFS) we try V2 first; if missing or
ROA-invalid, fall through to V1.

## The resolution chain

For each `.sol` domain, in order:

1. V2 IPFS (with valid ROA → return)
2. V1 IPFS
3. V2 IPNS (with valid ROA → return)
4. V1 IPNS
5. V2 ARWV (with valid ROA → return)
6. V1 ARWV
7. No content.

The first match wins. We mirror the priority used by SNS clients
(Brave, sns.id, 4everland) but skip URL/SHDW for v1. An IPFS slot whose
payload is `ipns://<key>` (SNS-client convention) is classified as
IPNS and re-routed accordingly — see `detectIpnsFromIpfsValue`.

## Two indexing problems, two mechanisms

| Problem | Mechanism | Frequency |
|---|---|---|
| Catch new domains as they're registered | Signature polling on SPL Name Service program | Forever, every minute |
| Onboard the ~700k–1M existing domains | `getProgramAccounts` snapshot + reverse lookup | **Once**, during initial setup |

After backfill is done, signature polling carries the world forward.

## Owners and addresses

`NameRegistryState.owner` is a Solana base58 pubkey. **It is
case-sensitive.** Lowercasing it changes its identity and breaks
signature verification. The shared-DB schema lowercases EVM addresses
by historical convention; for Solana we route through
`src/providers/address-normalizer.ts` which knows about chain casing
rules.

## Expiry

V1 SNS domains do not expire (one-time payment, perpetual ownership).
V2 introduces optional renewals but they're not the norm. So
`dns.expiresAt` is `NULL` for SNS rows.

## Where things go in our schema

| Column | SNS value |
|---|---|
| `name` | `"foo.sol"` |
| `node` | the SPL name-service account pubkey, base58 |
| `cid` | IPFS CID or Arweave transaction id |
| `contentType` | `'ipfs-ns'`, `'ipns-ns'`, or `'arweave-ns'` |
| `setupTxHash` | the Solana signature (base58 ~88-char) |
| `ownerAddress` | base58 wallet pubkey, **never lowercased** |
| `chain` | `'solana'` |
| `main` | `'sol'` |
| `expiresAt` | `null` |
| `ensResolverId` | `null` (SNS has no resolver indirection) |

## Further reading

- Bonfida SNS Guide — https://sns.guide/
- SPL Name Service docs — https://spl.solana.com/name-service
- `@bonfida/spl-name-service` SDK — https://github.com/SolanaNameService/sns-sdk
- SNS Records V2 spec — https://github.com/Bonfida/sns-records
