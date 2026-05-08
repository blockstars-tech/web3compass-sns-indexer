# ADR 0003 — Vendor entity files instead of extracting a shared package

## Context

Two services share entity files: `web3compassapi` (the schema
authority) and `web3compass-sns-indexer` (this repo). The "right" answer
in a long-lived ecosystem is a shared npm package
(`@web3compass/dns-types`) that both repos depend on.

For a small, two-service surface area, the shared package adds
overhead disproportionate to the payoff:

- A third place to publish (npm or GitHub Packages).
- A version-bump dance every time we touch an entity.
- A monorepo conversation we don't need yet.

## Decision

Vendor entity files by copy. Enforce parity with a CI check
(`scripts/check-entity-drift.ts`) that diffs the vendored files
against the upstream `web3compassapi` files at a known commit.

The drift check targets:

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

## Consequences

Positive:

- No publishing pipeline to run.
- Vendored files live next to the code that uses them — easier to
  read, easier to reason about.
- The drift check makes "we forgot to sync" a CI failure, not a
  silent runtime bug.

Negative:

- Mechanical copy-paste cost when upstream changes. The
  `yarn check:entities` script catches drift in CI.
- Two places the same lines exist. A bad mental model in the future
  could lead to "let me edit only here" mistakes — the drift check
  prevents the next deploy from succeeding.

## When to revisit

Extract a shared package when **all** of:

- A third service is added that needs the same entities.
- The drift cost (manual sync + CI check) starts to outweigh
  ergonomics.
- Someone signs up to own the package's release pipeline.

Until then, vendor.

## Related

- ADR 0001 (shared DB).
- ADR 0002 (no migrations here).
