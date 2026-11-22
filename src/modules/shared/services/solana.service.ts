import type { OnModuleDestroy } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Connection } from '@solana/web3.js';

import {
  createRoutedFetch,
  RPC_ROUTER_EVENTS,
  type RpcRouterEvent,
} from '../../../providers/rpc-router';
import { TokenBucket } from '../../../providers/token-bucket';
import { ApiConfigService } from './api-config.service';

export type RpcRouterStats = Record<RpcRouterEvent, number>;

const ROUTER_SUMMARY_INTERVAL_MS = 10 * 60 * 1000;

/** Host part of an endpoint URL — never the path/query, which may hold a key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * `@solana/web3.js` Connection wrapper that throttles every outbound
 * fetch through a process-wide token bucket (caps RPS, including calls
 * the Bonfida SDK makes internally). `disableRetryOnRateLimit` defers
 * 429 handling to `UtilsProvider.retryWithExponentialBackoff`.
 *
 * When `SOLANA_SECONDARY_RPC_URL` is set, the fetch hook becomes a
 * method-based router (`providers/rpc-router.ts`): a few read methods are
 * tried on the secondary endpoint first, with every doubtful answer
 * falling back to the primary. Unset = primary only, as before.
 */
@Injectable()
export class SolanaService implements OnModuleDestroy {
  readonly connection: Connection;

  private readonly logger = new Logger(SolanaService.name);

  private readonly routerStats?: RpcRouterStats;

  private readonly summaryTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
  ) {
    const { rpcUrl } = this.configService.solanaConfig;
    // `??` defaults keep partial config stubs (e.g. the live smoke test)
    // from handing `undefined` to the token bucket.
    const rps = this.configService.solanaRpcMaxRps ?? 10;
    const throttle = new TokenBucket(rps, rps);
    const secondaryUrl = this.configService.solanaSecondaryRpcUrl;

    const throttledFetch: typeof fetch = async (input, init) => {
      await throttle.acquire();

      // Pass-through to the global fetch — types match by typeof fetch.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return globalThis.fetch(input, init);
    };

    let fetchHook = throttledFetch;

    if (secondaryUrl) {
      const secondaryRps = this.configService.solanaSecondaryRpcMaxRps ?? 4;
      const stats = Object.fromEntries(
        RPC_ROUTER_EVENTS.map((event) => [event, 0]),
      ) as RpcRouterStats;

      this.routerStats = stats;
      fetchHook = createRoutedFetch({
        primaryUrl: rpcUrl,
        secondaryUrl,
        primaryBucket: throttle,
        secondaryBucket: new TokenBucket(secondaryRps, secondaryRps),
        onEvent: (event) => {
          stats[event] += 1;
        },
      });

      this.logger.log(
        'Solana RPC router on: account reads + getTransaction → secondary ' +
          `${hostOf(secondaryUrl)} (${secondaryRps} RPS); everything else ` +
          `and all fallbacks → primary ${hostOf(rpcUrl)}`,
      );

      this.summaryTimer = setInterval(
        () => this.logRouterSummary(),
        ROUTER_SUMMARY_INTERVAL_MS,
      );
      this.summaryTimer.unref();
    }

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      fetch: fetchHook,
      disableRetryOnRateLimit: true,
    });
  }

  /** Cumulative router counters since start; `undefined` when the router is off. */
  getRpcRouterStats(): Readonly<RpcRouterStats> | undefined {
    return this.routerStats ? { ...this.routerStats } : undefined;
  }

  onModuleDestroy(): void {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
    }

    this.logRouterSummary();
  }

  private logRouterSummary(): void {
    if (!this.routerStats) {
      return;
    }

    const summary = RPC_ROUTER_EVENTS.map(
      (event) => `${event}=${this.routerStats?.[event] ?? 0}`,
    ).join(' ');

    this.logger.log(`Solana RPC router (since start): ${summary}`);
  }
}
