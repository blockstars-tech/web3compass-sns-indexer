# Documentation

## Start here

- [`sns-overview.md`](./sns-overview.md) — end-to-end SNS indexing
  walkthrough. Best single doc to read if you want the whole picture.
- [`architecture.md`](./architecture.md) — module map and data flow.
- [`concepts.md`](./concepts.md) — Solana Name Service primer.

## Operating

- [`operations.md`](./operations.md) — local dev, RPC choice, deploy
  ordering, troubleshooting.
- [`data-model.md`](./data-model.md) — which Postgres columns we
  write, and the shared-DB contract with `web3compassapi`.

## Decisions

ADRs (architectural decision records) live in [`adr/`](./adr/). Each
is short and answers one question.

- [`adr/0001-shared-db-with-web3compassapi.md`](./adr/0001-shared-db-with-web3compassapi.md)
- [`adr/0002-no-migrations-in-this-repo.md`](./adr/0002-no-migrations-in-this-repo.md)
- [`adr/0003-vendoring-entity-files.md`](./adr/0003-vendoring-entity-files.md)
- [`adr/0004-poll-only-no-webhooks-no-wss.md`](./adr/0004-poll-only-no-webhooks-no-wss.md)
