import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { readFileSync } from 'fs';

import { SnakeNamingStrategy } from '../../../strategies/snake-naming.strategy';

/**
 * Slim config surface — only what the SNS indexer needs.
 */
@Injectable()
export class ApiConfigService {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  private getString(key: string, defaultValue?: string): string {
    const v = this.configService.get<string>(key, defaultValue);

    if (v === undefined || v === null) {
      throw new Error(`Missing required env var: ${key}`);
    }

    return v.toString().replace(/\\n/g, '\n');
  }

  private getStringOptional(key: string): string | undefined {
    const v = this.configService.get<string>(key);

    return v === undefined || v === null || v === '' ? undefined : v.toString();
  }

  private getNumber(key: string, defaultValue?: number): number {
    const v = this.configService.get<string | number>(key);

    if (v === undefined || v === null || v === '') {
      if (defaultValue !== undefined) {
        return defaultValue;
      }

      throw new Error(`Missing required env var: ${key}`);
    }

    return Number(v);
  }

  private getBoolean(key: string, defaultValue = false): boolean {
    const v = this.configService.get<string>(key);

    if (v === undefined || v === null || v === '') {
      return defaultValue;
    }

    return v.toLowerCase() === 'true' || v === '1';
  }

  get logLevel(): string {
    return this.getString('LOG_LEVEL', 'info');
  }

  /**
   * TypeORM config. Note: `migrationsRun: false`, `synchronize: false`.
   * Schema lives in `web3compassapi`. See ADR 0002.
   */
  get typeOrmConfig(): TypeOrmModuleOptions {
    const caPath =
      process.env.PG_CA_FILE || '/etc/ssl/certs/aws/global-bundle.pem';
    const useSSL = this.getString('PG_SSL');

    return {
      type: 'postgres',
      host: this.getString('DB_HOST'),
      port: this.getNumber('DB_PORT', 5432),
      username: this.getString('DB_USERNAME'),
      password: this.getString('DB_PASSWORD'),
      database: this.getString('DB_DATABASE'),
      ssl: useSSL
        ? { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') }
        : false,
      entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
      migrations: [],
      migrationsRun: false,
      synchronize: false,
      namingStrategy: new SnakeNamingStrategy(),
    };
  }

  get solanaConfig() {
    const explicitUrl = this.getStringOptional('SOLANA_RPC_URL');
    const provider = (
      this.getStringOptional('SOLANA_RPC_PROVIDER') || 'helius'
    ).toLowerCase();
    const network = (
      this.getStringOptional('SOLANA_RPC_NETWORK') || 'mainnet'
    ).toLowerCase();
    const apiKey = this.getStringOptional('SOLANA_RPC_API_KEY');

    if (explicitUrl) {
      return { provider: 'custom', network, rpcUrl: explicitUrl };
    }

    if (!apiKey) {
      throw new Error(
        'SOLANA_RPC_API_KEY is required when SOLANA_RPC_URL is not set',
      );
    }

    let rpcUrl: string;

    switch (provider) {
      case 'helius':
        rpcUrl =
          network === 'devnet'
            ? `https://devnet.helius-rpc.com/?api-key=${apiKey}`
            : `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
        break;
      case 'alchemy':
        rpcUrl =
          network === 'devnet'
            ? `https://solana-devnet.g.alchemy.com/v2/${apiKey}`
            : `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
        break;
      default:
        throw new Error(
          `Unknown SOLANA_RPC_PROVIDER='${provider}'. Use 'helius' | 'alchemy', or set SOLANA_RPC_URL to a full endpoint.`,
        );
    }

    return { provider, network, rpcUrl };
  }

  get snsCursorSeeds() {
    return {
      registerStartedSignature: this.getStringOptional(
        'SNS_REGISTER_STARTED_SIGNATURE',
      ),
      recordsV2StartedSignature: this.getStringOptional(
        'SNS_RECORDS_V2_STARTED_SIGNATURE',
      ),
    };
  }

  get backfillEnabled(): boolean {
    return this.getBoolean('SNS_BACKFILL_ENABLED', false);
  }

  /**
   * IPFS HTTP gateway prefix. Concatenated with `dns.cid` to produce the
   * `ipfsUrl` audit value on `dns_settings`. Trailing slash required.
   */
  get ipfsGatewayUrl(): string {
    return this.getString('IPFS_GATEWAY_URL', 'https://ipfs.io/ipfs/');
  }

  /**
   * Master switch for the cron-triggered jobs. The CLI runner
   * (`yarn cli:once <job>`) bypasses this gate so smoke runs work in
   * any environment.
   */
  get cronsEnabled(): boolean {
    return this.getBoolean('ENABLE_SNS_CRONS', false);
  }

  /**
   * Per-tick parallelism for `getParsedTransaction` in the register +
   * record-changes jobs. Defaults are tuned for free Alchemy / Helius;
   * raise via env on paid endpoints.
   */
  get snsTxFetchConcurrency(): number {
    return this.getNumber('SNS_TX_FETCH_CONCURRENCY', 2);
  }

  /**
   * Per-tick parallelism for `SnsService.resolveContent` in the reconcile
   * job. Each row triggers up to 4 RPC reads, so the effective RPS is
   * roughly 4× this value.
   */
  get snsResolveConcurrency(): number {
    return this.getNumber('SNS_RESOLVE_CONCURRENCY', 5);
  }

  /**
   * Process-wide cap on outbound Solana RPC requests, in requests-per-
   * second. Enforced by a token-bucket inside `SolanaService.connection`'s
   * fetch hook, so it covers every call — including Bonfida SDK internals
   * that callsite-level retries can't see. Default 10 is conservative for
   * free Alchemy / Helius; raise on paid endpoints (e.g. 50–100).
   */
  get solanaRpcMaxRps(): number {
    return this.getNumber('SOLANA_RPC_MAX_RPS', 10);
  }

  /**
   * How many partitions (owner-first-byte buckets, 0–255) the backfill
   * job processes per cron tick. The cursor in `dns_migrations` row
   * `SNS_BACKFILL` advances by this many partitions per successful tick.
   *
   * Default 2 = ~6k accounts/tick at typical owner distribution. The
   * conservative default is tuned for free-tier RPC where the heavy
   * `getProgramAccounts` call competes with other jobs for the shared
   * CU/s budget. Paid tiers (Helius Developer+, Alchemy Growth+) can
   * raise to e.g. 16–32 to finish backfill in well under an hour.
   */
  get snsBackfillPartitionsPerTick(): number {
    return this.getNumber('SNS_BACKFILL_PARTITIONS_PER_TICK', 2);
  }

  /**
   * Reverse-lookup batch size inside a partition. Each batch is one
   * `getMultipleAccountsInfo` call (capped at 100 keys per call by the
   * RPC). Default 50 leaves headroom on free-tier rate limits.
   */
  get snsBackfillBatchSize(): number {
    return this.getNumber('SNS_BACKFILL_BATCH_SIZE', 50);
  }
}
