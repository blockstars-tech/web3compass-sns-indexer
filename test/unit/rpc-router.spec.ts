import { describe, expect, it, vi } from 'vitest';

import {
  createRoutedFetch,
  type IRoutedFetchOptions,
  type RpcRouterEvent,
} from '../../src/providers/rpc-router';
import { TokenBucket } from '../../src/providers/token-bucket';

const PRIMARY = 'https://primary.test/rpc';
// Stand-in for a key-bearing URL; must never leak into events.
const SECONDARY = 'https://secondary.test/0123456789abcdef0123456789abcdef';

type Handler = (method: string, init?: RequestInit) => Response | Promise<Response>;

function rpcBody(method: string, params: unknown[] = []): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResult(result: unknown): Response {
  return json({ jsonrpc: '2.0', id: 1, result });
}

function accountResult(slot: number | undefined, value: unknown = { lamports: 1 }): Response {
  return rpcResult({ context: slot === undefined ? {} : { slot }, value });
}

function setup(
  handlers: { primary?: Handler; secondary?: Handler },
  overrides: Partial<IRoutedFetchOptions> = {},
) {
  const calls: Array<{ target: 'primary' | 'secondary'; method: string }> = [];
  const events: RpcRouterEvent[] = [];

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? '';
    const target = url === SECONDARY ? 'secondary' : 'primary';
    calls.push({ target, method });
    const handler = target === 'secondary' ? handlers.secondary : handlers.primary;

    if (!handler) {
      throw new Error(`no ${target} handler`);
    }

    return handler(method, init);
  }) as unknown as typeof fetch;

  const routed = createRoutedFetch({
    primaryUrl: PRIMARY,
    secondaryUrl: SECONDARY,
    primaryBucket: new TokenBucket(1000),
    secondaryBucket: new TokenBucket(1000),
    fetchImpl,
    onEvent: (e) => events.push(e),
    ...overrides,
  });

  const call = (method: string, params: unknown[] = []) =>
    routed('https://ignored.test', { method: 'POST', body: rpcBody(method, params) });

  return { routed, call, calls, events };
}

const primaryOk: Handler = (method) =>
  method === 'getAccountInfo' || method === 'getMultipleAccounts'
    ? accountResult(1, 'from-primary')
    : rpcResult('from-primary');

describe('createRoutedFetch', () => {
  it('sends the three read methods to the secondary and everything else to the primary', async () => {
    const { call, calls } = setup({
      primary: primaryOk,
      secondary: (method) =>
        method === 'getTransaction' ? rpcResult({ slot: 5 }) : accountResult(5),
    });

    for (const m of ['getAccountInfo', 'getMultipleAccounts', 'getTransaction']) {
      await call(m);
    }

    for (const m of ['getSignaturesForAddress', 'getProgramAccounts', 'getSlot']) {
      await call(m);
    }

    expect(calls).toEqual([
      { target: 'secondary', method: 'getAccountInfo' },
      { target: 'secondary', method: 'getMultipleAccounts' },
      { target: 'secondary', method: 'getTransaction' },
      { target: 'primary', method: 'getSignaturesForAddress' },
      { target: 'primary', method: 'getProgramAccounts' },
      { target: 'primary', method: 'getSlot' },
    ]);
  });

  it('sends batch (array) and non-JSON bodies to the primary', async () => {
    const seen: string[] = [];
    const routed = createRoutedFetch({
      primaryUrl: PRIMARY,
      secondaryUrl: SECONDARY,
      primaryBucket: new TokenBucket(1000),
      secondaryBucket: new TokenBucket(1000),
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(String(input));

        return rpcResult('ok');
      }) as unknown as typeof fetch,
    });

    await routed('x', {
      method: 'POST',
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [] }]),
    });
    await routed('x', { method: 'POST', body: 'not json' });

    expect(seen).toEqual([PRIMARY, PRIMARY]);
  });

  it('returns a secondary response the caller can parse', async () => {
    const { call, events } = setup({ secondary: () => accountResult(7, null) });

    const res = await call('getAccountInfo');
    const parsed = (await res.json()) as { result: { value: unknown } };

    // A missing account (value: null) at a fresh slot is valid data.
    expect(parsed.result.value).toBeNull();
    expect(events).toEqual(['secondary_ok']);
  });

  it.each([
    ['a thrown fetch', () => Promise.reject(new Error(`connect failed ${SECONDARY}`))],
    ['HTTP 403', () => json({ error: { code: -32_002, message: 'plan' } }, 403)],
    ['HTTP 429', () => json({}, 429)],
    ['a JSON-RPC error', () => json({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })],
    ['invalid JSON', () => new Response('<html>', { status: 200 })],
    ['a string result', () => rpcResult('not-an-object')],
  ])('falls back to the primary on %s', async (_label, secondary) => {
    const { call, calls, events } = setup({ primary: primaryOk, secondary });

    const res = await call('getAccountInfo');
    const parsed = (await res.json()) as { result: { value: unknown } };

    expect(parsed.result.value).toBe('from-primary');
    expect(calls.map((c) => c.target)).toEqual(['secondary', 'primary']);
    expect(events).toEqual(['fallback_error']);
  });

  it('cancels the secondary body on a non-2xx before falling back', async () => {
    const res403 = json({}, 403);
    const cancel = vi.spyOn(res403.body as ReadableStream, 'cancel');
    const { call } = setup({ primary: primaryOk, secondary: () => res403 });

    await call('getAccountInfo');

    expect(cancel).toHaveBeenCalled();
  });

  it('falls back when getTransaction is null on the secondary', async () => {
    const { call, calls, events } = setup({
      primary: () => rpcResult({ slot: 9, tx: 'from-primary' }),
      secondary: () => rpcResult(null),
    });

    const parsed = (await (await call('getTransaction')).json()) as { result: { tx: string } };

    expect(parsed.result.tx).toBe('from-primary');
    expect(calls.map((c) => c.target)).toEqual(['secondary', 'primary']);
    expect(events).toEqual(['fallback_null']);
  });

  it('falls back on stale account reads and serves fresh ones', async () => {
    let secondarySlot = 995;
    const { call, calls, events } = setup({
      primary: (method) =>
        method === 'getSignaturesForAddress'
          ? rpcResult([{ slot: 1000 }, { slot: 990 }])
          : accountResult(1000, 'from-primary'),
      secondary: () => accountResult(secondarySlot),
    });

    // The high-water slot is updated before this call resolves, so the
    // very next read already sees it.
    await call('getSignaturesForAddress');
    await call('getAccountInfo');
    secondarySlot = 1001;
    await call('getAccountInfo');

    expect(calls.map((c) => `${c.target}:${c.method}`)).toEqual([
      'primary:getSignaturesForAddress',
      'secondary:getAccountInfo',
      'primary:getAccountInfo',
      'secondary:getAccountInfo',
    ]);
    expect(events).toEqual(['fallback_stale', 'secondary_ok']);
  });

  it('treats a missing context.slot as stale', async () => {
    const { call, events } = setup({
      primary: primaryOk,
      secondary: () => accountResult(undefined),
    });

    await call('getMultipleAccounts');

    expect(events).toEqual(['fallback_stale']);
  });

  it('leaves the high-water slot unchanged on an empty signature page', async () => {
    const { call, events } = setup({
      primary: (method) =>
        method === 'getSignaturesForAddress' ? rpcResult([]) : primaryOk(method),
      secondary: () => accountResult(0),
    });

    await call('getSignaturesForAddress');
    await call('getAccountInfo');

    expect(events).toEqual(['secondary_ok']);
  });

  it('never clones primary responses other than the slot-revealing ones', async () => {
    const res = rpcResult([{ pubkey: 'x' }]);
    const clone = vi.spyOn(res, 'clone');
    const { call } = setup({ primary: () => res });

    await call('getProgramAccounts');

    expect(clone).not.toHaveBeenCalled();
  });

  it('overflows to the primary at once when the secondary budget is used up', async () => {
    const { call, calls, events } = setup(
      { primary: primaryOk, secondary: () => accountResult(5) },
      { secondaryBucket: new TokenBucket(1, 0.001) },
    );

    const start = Date.now();
    await call('getAccountInfo');
    await call('getAccountInfo');

    expect(Date.now() - start).toBeLessThan(200);
    expect(calls.map((c) => c.target)).toEqual(['secondary', 'primary']);
    expect(events).toEqual(['secondary_ok', 'overflow']);
  });

  it('times out a stalled secondary and falls back', async () => {
    const stalled: Handler = (_m, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { call, calls, events } = setup(
      { primary: primaryOk, secondary: stalled },
      { secondaryTimeoutMs: 20 },
    );

    const start = Date.now();
    await call('getAccountInfo');

    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls.map((c) => c.target)).toEqual(['secondary', 'primary']);
    expect(events).toEqual(['fallback_error']);
  });

  it('opens the breaker after repeated errors and closes it after a successful probe', async () => {
    let clock = 0;
    let isSecondaryDown = true;
    const { call, calls, events } = setup(
      {
        primary: primaryOk,
        secondary: () => (isSecondaryDown ? json({}, 503) : accountResult(5)),
      },
      { now: () => clock, breakerThreshold: 3, breakerCooldownMs: 60_000 },
    );

    for (let i = 0; i < 3; i += 1) {
      await call('getAccountInfo');
    }

    // Open: the secondary is not touched at all.
    await call('getAccountInfo');
    expect(calls.filter((c) => c.target === 'secondary')).toHaveLength(3);

    // After the cooldown a single probe goes through and closes it.
    clock = 60_001;
    isSecondaryDown = false;
    await call('getAccountInfo');
    await call('getAccountInfo');

    expect(events).toEqual([
      'fallback_error',
      'fallback_error',
      'fallback_error',
      'bypass',
      'secondary_ok',
      'secondary_ok',
    ]);
  });

  it('re-opens the breaker when the probe fails', async () => {
    let clock = 0;
    const { call, events } = setup(
      { primary: primaryOk, secondary: () => json({}, 503) },
      { now: () => clock, breakerThreshold: 2, breakerCooldownMs: 1000 },
    );

    await call('getAccountInfo');
    await call('getAccountInfo');
    clock = 1001;
    await call('getAccountInfo'); // probe fails
    await call('getAccountInfo'); // open again

    expect(events).toEqual(['fallback_error', 'fallback_error', 'fallback_error', 'bypass']);
  });

  it('does not open the breaker on null or stale answers', async () => {
    const { call, events } = setup(
      { primary: primaryOk, secondary: () => rpcResult(null) },
      { breakerThreshold: 2 },
    );

    for (let i = 0; i < 4; i += 1) {
      await call('getTransaction');
    }

    expect(events).toEqual(['fallback_null', 'fallback_null', 'fallback_null', 'fallback_null']);
  });

  it('never puts the secondary URL into events', async () => {
    const { call, events } = setup({
      primary: primaryOk,
      secondary: () => Promise.reject(new Error(`ECONNREFUSED ${SECONDARY}`)),
    });

    await call('getAccountInfo');

    expect(JSON.stringify(events)).not.toContain('secondary.test');
  });
});
