import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SolanaService } from '../../src/modules/shared/services/solana.service';

const PRIMARY = 'https://primary.test/rpc';
const SECONDARY = 'https://secondary.test/0123456789abcdef';
const KEY = new PublicKey('58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx');

function stubConfig(extra: Record<string, unknown> = {}) {
  return {
    solanaConfig: { provider: 'custom', network: 'mainnet', rpcUrl: PRIMARY },
    solanaRpcMaxRps: 1000,
    solanaSecondaryRpcUrl: undefined,
    solanaSecondaryRpcMaxRps: 1000,
    ...extra,
  };
}

function stubFetch(): string[] {
  const urls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      const { id, method } = JSON.parse(String(init?.body)) as {
        id: unknown;
        method: string;
      };
      const result =
        method === 'getSlot' ? 10 : { context: { slot: 10 }, value: null };

      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );

  return urls;
}

function build(config: ReturnType<typeof stubConfig>): SolanaService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SolanaService(config as any);
}

describe('SolanaService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends everything to the primary when no secondary is configured', async () => {
    const urls = stubFetch();
    const service = build(stubConfig());

    await service.connection.getAccountInfo(KEY);
    await service.connection.getSlot();

    expect(urls).toEqual([PRIMARY, PRIMARY]);
    expect(service.getRpcRouterStats()).toBeUndefined();
  });

  it('routes account reads to the secondary when configured', async () => {
    const urls = stubFetch();
    const service = build(stubConfig({ solanaSecondaryRpcUrl: SECONDARY }));

    await service.connection.getAccountInfo(KEY);
    await service.connection.getSlot();

    expect(urls).toEqual([SECONDARY, PRIMARY]);
    expect(service.getRpcRouterStats()?.secondary_ok).toBe(1);
    service.onModuleDestroy();
  });

  it('falls back to defaults when a partial config omits the RPS caps', async () => {
    const urls = stubFetch();
    const service = build({
      solanaConfig: { provider: 'custom', network: 'mainnet', rpcUrl: PRIMARY },
    } as ReturnType<typeof stubConfig>);

    await service.connection.getSlot();

    expect(urls).toEqual([PRIMARY]);
  });
});
