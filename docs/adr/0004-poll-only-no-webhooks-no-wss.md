# ADR 0004 — Polling-only; no webhooks, no WebSocket subscriptions

## Context

Solana has three mechanisms to detect changes:

1. **HTTP polling** of `getSignaturesForAddress(program)` — what we
   use. Lag: cron tick (≤1 minute).
2. **WebSocket `programSubscribe`** — persistent connection, receives
   account-change pushes. Sub-second latency, but needs robust
   reconnect / replay logic.
3. **Provider webhooks** (Helius, etc.) — webhook delivery from a
   provider service. Sub-second latency, but introduces a vendor
   coupling and an inbound HTTP surface to operate.

The user explicitly opted for polling-only in `sns-research.md` § 3.2.

## Decision

The SNS indexer uses HTTP polling for all change detection:

- New domain registrations: signature poll on SPL Name Service.
- Record changes (V1): same poll catches them (V1 record changes
  land on SPL Name Service).
- Record changes (V2): signature poll on SNS Records V2 program.
- Owner transfers: caught by signature poll + reconcile re-read of
  `NameRegistryState.owner`.
- Backstop: `getAccountInfo` with `changedSinceSlot` sweep, to catch
  anything the signature walks missed.

No WSS. No webhooks. No long-lived inbound endpoints.

## Consequences

Positive:

- Pure HTTP. No reconnect logic, no missed-message replay, no fan-out
  across processes.
- Provider-agnostic. Swap RPC by changing one env var.
- Mirrors the pattern already used by the EVM indexers in
  `web3compassapi` — operationally familiar.

Negative:

- Detection latency is bounded by cron cadence (1 minute for register
  + record changes, 30 seconds for reconciliation). For most product
  uses this is fine; for "real-time" requirements it is not.

## When to revisit

Add WebSocket `programSubscribe` if:

- A product feature genuinely requires sub-minute freshness on
  content-pointer changes.
- We're already operating Solana WSS clients elsewhere.

The data flow is designed so that adding a WSS adapter wouldn't change
the reconcile or sweep paths — it would just be another upstream of
`needsReindex = true`.

## Related

- `docs/operations.md` — RPC provider choice.
