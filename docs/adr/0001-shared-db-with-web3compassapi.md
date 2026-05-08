# ADR 0001 — Shared Postgres database with `web3compassapi`

## Context

`web3compass-sns-indexer` is a sibling indexer to `web3compassapi`.
Both services are responsible for filling in the same `dns` table —
upstream covers ENS / TOMI / BNB / UNS, this repo covers SNS.

The original draft of the SNS plan proposed an own-DB / HTTP-API
architecture. That was reconsidered: the indexer is not a standalone
product, and a separate DB would force `web3compassapi` to consume an
HTTP contract for what is structurally just "another chain we
happen to host in a separate repo." The downstream content-indexer
already reads `web3compassapi`'s tables; making it learn a second
data source for SNS would be net-negative.

## Decision

Both services share one Postgres database. This repo connects with the
same `DB_*` env vars as `web3compassapi`. Entity files describing
`dns`, `dns_migrations`, `cid_processing`, `content_pointer`, etc., are
**vendored copies** of the upstream files.

## Consequences

Positive:

- Downstream readers (the content-indexer) get SNS rows for free.
- No HTTP/event contract to design, version, secure, or operate.
- Entity files are familiar; new contributors can read upstream code
  and apply the same patterns.

Negative:

- Schema drift becomes a real failure mode (see ADR 0002 + the
  `check:entities` CI step).
- Two services write to the same tables. Concurrency is bounded by
  `isJobRunning` + chain-specific cursors, but two engineers must be
  aware of the other repo's write paths.
- Operational coupling: deploys must be ordered (schema first in
  upstream, then this repo).

The trade-off is tilted heavily toward "shared DB" because:

- The whole point of separating this repo is **public visibility**,
  not architectural isolation. The split is a packaging decision.
- The volume of data SNS adds (~1M rows) is small relative to what
  `web3compassapi` already handles.

## Related

- ADR 0002 (no migrations in this repo).
- ADR 0003 (vendoring entity files).
