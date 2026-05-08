import { Inject, Injectable } from '@nestjs/common';
import { Connection } from '@solana/web3.js';

import { TokenBucket } from '../../../providers/token-bucket';
import { ApiConfigService } from './api-config.service';

/**
 * `@solana/web3.js` Connection wrapper that throttles every outbound
 * fetch through a process-wide token bucket (caps RPS, including calls
 * the Bonfida SDK makes internally). `disableRetryOnRateLimit` defers
 * 429 handling to `UtilsProvider.retryWithExponentialBackoff`.
 */
@Injectable()
export class SolanaService {
  readonly connection: Connection;

  constructor(
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
  ) {
    const { rpcUrl } = this.configService.solanaConfig;
    const rps = this.configService.solanaRpcMaxRps;
    const throttle = new TokenBucket(rps, rps);

    const throttledFetch: typeof fetch = async (input, init) => {
      await throttle.acquire();

      return globalThis.fetch(input, init);
    };

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      fetch: throttledFetch,
      disableRetryOnRateLimit: true,
    });
  }
}
