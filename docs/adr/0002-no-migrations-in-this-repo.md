# ADR 0002 — No migrations in this repo

## Context

Two NestJS services with their own `DataSource` and `migrationsRun:
true` running against one Postgres database is a race-condition
factory. Whichever boots first wins; the other may apply diverging
migrations or fail mysteriously.

## Decision

Only `web3compassapi` runs migrations. This repo:

- Sets `migrationsRun: false` in its TypeORM config.
- Has no `src/migrations/` directory.
- Lists `migrations: []` in `ormconfig.ts`.
- Lists CLI scripts (`migration:generate`, `migration:run`, etc.) as
  **intentionally absent** from `package.json`. The TypeORM CLI
  resolves the data source for type-checking only.

## Consequences

Positive:

- One source of truth for schema. Easier to reason about, easier to
  back up / restore.
- Drift between the two repos is eliminated by construction.

Negative:

- Schema bumps that benefit only SNS still require a PR in upstream.
  Round-trip cost: hours, not days.
- An engineer has to remember which repo to PR a schema change in.
  The deploy ordering in `docs/operations.md` is the canonical reminder.

## Enforcement

- `ormconfig.ts` literal: `migrationsRun: false`, `synchronize: false`,
  `migrations: []`.
- No `src/migrations/` directory. If someone adds one, treat it as a
  bug to revert.
- Entity drift check (`yarn check:entities`) catches accidental
  entity edits that imply a schema change.

## Related

- ADR 0001 (shared DB rationale).
- ADR 0003 (vendoring entity files).
