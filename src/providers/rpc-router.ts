/* eslint-disable @typescript-eslint/no-unsafe-argument -- `fetch`'s
   RequestInit / Response types resolve loosely under this tsconfig; same
   precedent as the fetch hook in solana.service.ts. */
import type { TokenBucket } from './token-bucket';

/**
 * Method-based Solana RPC router used as `Connection`'s `fetch` hook.
 *
 * A small set of read methods is sent to a secondary endpoint (e.g. a
 * free-tier provider). Everything else, and every doubtful secondary
 * answer, goes to the primary endpoint — so results match a
 * primary-only setup:
 *
 * - errors, timeouts, non-2xx and malformed bodies → primary
 *   (`fallback_error`, counts toward the circuit breaker);
 * - `getTransaction` returning `null` (secondary not caught up yet) →
 *   primary (`fallback_null`);
 * - account reads whose `context.slot` is older than the newest slot the
 *   indexer has already seen from the primary → primary (`fallback_stale`);
 * - secondary budget used up → primary at once, never waits (`overflow`);
 * - breaker open after repeated errors → primary (`bypass`).
 *
 * Never logs or emits the endpoint URLs: they may embed API keys.
 */

export type RpcRouterEvent =
  | 'secondary_ok'
  | 'overflow'
  | 'bypass'
  | 'fallback_error'
  | 'fallback_null'
  | 'fallback_stale';

export const RPC_ROUTER_EVENTS: readonly RpcRouterEvent[] = [
  'secondary_ok',
  'overflow',
  'bypass',
  'fallback_error',
  'fallback_null',
  'fallback_stale',
];

/** JSON-RPC methods eligible for the secondary endpoint. */
export const SECONDARY_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getTransaction',
]);

const ACCOUNT_READ_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
]);

/** Primary responses that reveal the newest slot the indexer has seen. */
const HIGH_WATER_METHODS: ReadonlySet<string> = new Set([
  'getSignaturesForAddress',
  'getTransaction',
]);

export interface IRoutedFetchOptions {
  primaryUrl: string;
  secondaryUrl: string;
  /** Caps the primary endpoint (blocking, as before). */
  primaryBucket: TokenBucket;
  /** Caps the secondary endpoint (non-blocking: overflow goes to primary). */
  secondaryBucket: TokenBucket;
  fetchImpl?: typeof fetch;
  onEvent?: (event: RpcRouterEvent) => void;
  /** Per-request timeout for the secondary attempt. Default 5 000 ms. */
  secondaryTimeoutMs?: number;
  /** Consecutive secondary errors that open the breaker. Default 3. */
  breakerThreshold?: number;
  /** How long the breaker stays open. Default 60 000 ms. */
  breakerCooldownMs?: number;
  now?: () => number;
}

type SecondaryOutcome =
  | { kind: 'ok'; response: Response }
  | { kind: 'fallback_error' | 'fallback_null' | 'fallback_stale' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ignoreError(): void {
  // Intentionally ignored: best-effort cleanup.
}

/** Raise `current` to the newest slot a primary response reveals. */
function highWaterFrom(method: string, body: unknown, current: number): number {
  const result = isRecord(body) ? body.result : undefined;
  const slots: unknown[] = [];

  if (method === 'getSignaturesForAddress' && Array.isArray(result)) {
    for (const sig of result) {
      slots.push(isRecord(sig) ? sig.slot : undefined);
    }
  } else if (method === 'getTransaction' && isRecord(result)) {
    slots.push(result.slot);
  } else {
    return current;
  }

  let next = current;

  for (const slot of slots) {
    if (typeof slot === 'number' && Number.isFinite(slot)) {
      next = Math.max(next, slot);
    }
  }

  return next;
}

/** The JSON-RPC method of a single (non-batch) request body, if any. */
function rpcMethodOf(body: unknown): string | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(body);

    return isRecord(parsed) && typeof parsed.method === 'string'
      ? parsed.method
      : undefined;
  } catch {
    return undefined;
  }
}

export function createRoutedFetch(options: IRoutedFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.secondaryTimeoutMs ?? 5000;
  const threshold = options.breakerThreshold ?? 3;
  const cooldownMs = options.breakerCooldownMs ?? 60_000;
  const now = options.now ?? Date.now;

  let highWaterSlot = 0;
  let consecutiveErrors = 0;
  let breakerOpenUntil = 0;
  let isProbeInFlight = false;

  const emit = (event: RpcRouterEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability must never break a request.
    }
  };

  const callPrimary = async (
    method: string | undefined,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    await options.primaryBucket.acquire();
    const res = await fetchImpl(options.primaryUrl, init);

    // Clone only the small responses we learn slots from — never e.g.
    // multi-MB `getProgramAccounts` payloads. Awaited, so the next
    // account read already sees the updated high-water slot.
    if (res.ok && method !== undefined && HIGH_WATER_METHODS.has(method)) {
      try {
        const body: unknown = await res.clone().json();
        highWaterSlot = highWaterFrom(method, body, highWaterSlot);
      } catch {
        // A bad body must never break the primary path; the caller
        // parses `res` itself and sees the same problem.
      }
    }

    return res;
  };

  const trySecondary = async (
    method: string,
    init: RequestInit | undefined,
  ): Promise<SecondaryOutcome> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;

    try {
      const res = await fetchImpl(options.secondaryUrl, { ...init, signal });

      if (!res.ok) {
        // Release the keep-alive socket before falling back.
        void res.body?.cancel().catch(ignoreError);

        return { kind: 'fallback_error' };
      }

      const text: string = await res.text();
      const parsed: unknown = JSON.parse(text);

      if (!isRecord(parsed) || parsed.error !== undefined) {
        return { kind: 'fallback_error' };
      }

      const { result } = parsed;

      if (method === 'getTransaction' && result === null) {
        return { kind: 'fallback_null' };
      }

      if (!isRecord(result)) {
        return { kind: 'fallback_error' };
      }

      if (ACCOUNT_READ_METHODS.has(method)) {
        const slot = isRecord(result.context) ? result.context.slot : undefined;

        if (typeof slot !== 'number' || slot < highWaterSlot) {
          return { kind: 'fallback_stale' };
        }
      }

      return {
        kind: 'ok',
        response: new Response(text, {
          status: res.status,
          statusText: res.statusText,
          headers: [['content-type', 'application/json']],
        }),
      };
    } catch {
      // Network failure, timeout, abort or invalid JSON. Deliberately
      // dropped: error messages can echo the endpoint URL (and its key).
      return { kind: 'fallback_error' };
    }
  };

  return async (_input, init) => {
    const method = rpcMethodOf(init?.body);

    if (method === undefined || !SECONDARY_METHODS.has(method)) {
      return callPrimary(method, init);
    }

    const isBreakerTripped = consecutiveErrors >= threshold;

    if (isBreakerTripped && (now() < breakerOpenUntil || isProbeInFlight)) {
      emit('bypass');

      return callPrimary(method, init);
    }

    if (!options.secondaryBucket.tryAcquire()) {
      emit('overflow');

      return callPrimary(method, init);
    }

    // Past the cooldown: this request is the single half-open probe.
    if (isBreakerTripped) {
      isProbeInFlight = true;
    }

    let outcome: SecondaryOutcome;

    try {
      outcome = await trySecondary(method, init);
    } finally {
      isProbeInFlight = false;
    }

    if (outcome.kind === 'fallback_error') {
      consecutiveErrors += 1;

      if (consecutiveErrors >= threshold) {
        breakerOpenUntil = now() + cooldownMs;
      }
    } else {
      // The secondary answered with a valid body: it is healthy, even if
      // that answer was empty or stale.
      consecutiveErrors = 0;
    }

    if (outcome.kind === 'ok') {
      emit('secondary_ok');

      return outcome.response;
    }

    emit(outcome.kind);

    return callPrimary(method, init);
  };
}
