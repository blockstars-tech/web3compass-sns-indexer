import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { ChainEnum } from '../../../constants/chain.enum';
import {
  SOL_TLD_ROOT,
  SPL_NAME_SERVICE_PROGRAM_ID,
} from '../../../constants/sns.constants';
import { UtilsProvider } from '../../../providers/utils.provider';
import type { DnsEntity } from '../../dns/dns.entity';
import { DnsRepository } from '../../dns/dns.repository';
import { DnsMigrationRepository } from '../../dns/dns-migration.repository';
import { ApiConfigService } from '../../shared/services/api-config.service';
import { SnsService } from '../../shared/services/sns.service';
import { SolanaService } from '../../shared/services/solana.service';

// Partition by `NameRegistryState.owner[0]`. 256 partitions × ~3k accounts
// each keeps every `getProgramAccounts` payload under free-tier limits.
const TOTAL_PARTITIONS = 256;
const OWNER_OFFSET = 32;

/**
 * Backfills every top-level `.sol` domain into the `dns` table. Cursor is
 * the next partition to process; on per-partition failure, holds the
 * cursor and replays next tick. Idempotent name-keyed upserts make replay
 * safe. Reconcile drains the resulting `cid IS NULL` rows on its own
 * schedule. Gated by `ENABLE_SNS_CRONS` + `SNS_BACKFILL_ENABLED`.
 */
@Injectable()
export class SnsBackfillJob {
  private isJobRunning = false;

  constructor(
    @InjectPinoLogger(SnsBackfillJob.name)
    private readonly logger: PinoLogger,
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
    @Inject(DnsRepository)
    private readonly dnsRepository: DnsRepository,
    @Inject(DnsMigrationRepository)
    private readonly dnsMigrationRepository: DnsMigrationRepository,
    @Inject(SolanaService)
    private readonly solanaService: SolanaService,
    @Inject(SnsService)
    private readonly snsService: SnsService,
  ) {}

  @Cron('0 */2 * * * *', { name: 'sns_backfill' })
  async runOnSchedule(): Promise<void> {
    if (!this.configService.cronsEnabled) {
      return;
    }

    if (!this.configService.backfillEnabled) {
      return;
    }

    await this.handle();
  }

  async handle(): Promise<void> {
    if (this.isJobRunning) {
      this.logger.info('SNS backfill: job already running');

      return;
    }

    this.isJobRunning = true;

    try {
      const cursor =
        await this.dnsMigrationRepository.getSnsBackfillMigrationInfo();

      if (cursor.isMigrated) {
        this.logger.info(
          'SNS backfill: cursor marks completion (isMigrated=true). Reset the dns_migrations row to re-run.',
        );

        return;
      }

      const startPartition = cursor.lastMigratedBlockNumber || 0;
      const perTick = this.configService.snsBackfillPartitionsPerTick;
      const endPartition = Math.min(startPartition + perTick, TOTAL_PARTITIONS);

      this.logger.info(
        `SNS backfill: tick start — processing partitions [${startPartition}..${endPartition - 1}] of ${TOTAL_PARTITIONS}`,
      );

      let processedPartitions = 0;
      let attempted = 0;
      let noReverse = 0;

      for (
        let partition = startPartition;
        partition < endPartition;
        partition += 1
      ) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await this.processPartition(partition);

          attempted += result.attempted;
          noReverse += result.noReverse;
          processedPartitions += 1;

          // eslint-disable-next-line no-await-in-loop
          await this.dnsMigrationRepository.saveSnsBackfillMigration({
            lastBlock: partition + 1,
          });

          const stats = `accounts=${result.totalAccounts} attempted=${result.attempted} noReverse=${result.noReverse}`;
          this.logger.info(
            `SNS backfill: partition ${partition} done (${stats})`,
          );
        } catch (error) {
          this.logger.warn(
            { err: error, partition },
            `SNS backfill: partition ${partition} failed; cursor held for replay next tick`,
          );
          // Don't advance past errors. Break so the cursor stays at this
          // partition; next tick re-tries it. ON CONFLICT DO NOTHING in
          // processBatch makes replay idempotent.
          break;
        }
      }

      // Mark complete only when we actually reached partition 256.
      if (
        startPartition + processedPartitions === TOTAL_PARTITIONS &&
        endPartition === TOTAL_PARTITIONS
      ) {
        await this.dnsMigrationRepository.saveSnsBackfillMigration({
          lastBlock: TOTAL_PARTITIONS,
          isMigrated: true,
        });

        this.logger.info(
          `SNS backfill: COMPLETE — all ${TOTAL_PARTITIONS} partitions processed`,
        );
      } else {
        const nextCursor = startPartition + processedPartitions;
        const stats = `attempted=${attempted} noReverse=${noReverse}`;
        this.logger.info(
          `SNS backfill: tick end — ${processedPartitions}/${perTick} partitions ` +
            `(${stats}); next cursor=${nextCursor}`,
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'SNS backfill: tick failed');
    } finally {
      this.isJobRunning = false;
    }
  }

  // Process each page as it lands so a partition that fails mid-pagination
  // still leaves earlier pages inserted; idempotent upserts cover replay.
  private async processPartition(partition: number): Promise<{
    totalAccounts: number;
    attempted: number;
    noReverse: number;
  }> {
    const ownerPrefixByte = Buffer.from([partition]);
    const ownerPrefixBase58 = bs58.encode(ownerPrefixByte);
    const filters = [
      // Top-level `.sol` only.
      { memcmp: { offset: 0, bytes: SOL_TLD_ROOT.toBase58() } },
      // Partition: domain accounts whose owner first byte == partition.
      { memcmp: { offset: OWNER_OFFSET, bytes: ownerPrefixBase58 } },
    ];

    const batchSize = this.configService.snsBackfillBatchSize;
    let totalAccounts = 0;
    let attempted = 0;
    let noReverse = 0;

    const provider = this.configService.solanaConfig.provider;
    const isHeliusV2 = provider === 'helius';

    let paginationKey: string | undefined;

    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await UtilsProvider.retryWithExponentialBackoff(
        () =>
          isHeliusV2
            ? this.fetchPageHeliusV2(filters, paginationKey)
            : this.fetchPageSdkV1(filters),
        // Patient retries: free-tier endpoints serialize requests on the
        // same key and may take seconds-to-minutes to recover from a
        // burst. Total budget across 12 attempts ≈ 14 min. The 2-min
        // cron interval will fire mid-retry and see `isJobRunning=true`
        // (no-op) — safe.
        { retries: 12, delay: 2000, maxDelay: 120_000 },
      );

      totalAccounts += page.keys.length;

      // Process this page's keys before fetching the next one. If
      // pagination fails halfway through, rows from completed pages are
      // already inserted and re-running the partition just re-inserts
      // them idempotently.
      for (let i = 0; i < page.keys.length; i += batchSize) {
        const slice = page.keys.slice(i, i + batchSize);
        // eslint-disable-next-line no-await-in-loop
        const result = await this.processBatch(slice);
        attempted += result.attempted;
        noReverse += result.noReverse;
      }

      paginationKey = page.paginationKey;
    } while (paginationKey);

    return { totalAccounts, attempted, noReverse };
  }

  // Helius `getProgramAccountsV2` via raw JSON-RPC — the SDK doesn't expose
  // it. Helius requires V2 for large datasets; V1 hits "account index
  // service overloaded" on SPL Name Service.
  private async fetchPageHeliusV2(
    filters: Array<{ memcmp: { offset: number; bytes: string } }>,
    paginationKey: string | undefined,
  ): Promise<{ keys: PublicKey[]; paginationKey: string | undefined }> {
    const rpcUrl = this.configService.solanaConfig.rpcUrl;

    const body = {
      jsonrpc: '2.0',
      id: '1',
      method: 'getProgramAccountsV2',
      params: [
        SPL_NAME_SERVICE_PROGRAM_ID.toBase58(),
        {
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
          filters,
          // Max page size per Helius docs. We're already partition-
          // filtered to ~3k accounts on average, so usually one page.
          limit: 10_000,
          ...(paginationKey ? { paginationKey } : {}),
        },
      ],
    };

    const response = await fetch(rpcUrl, {
      method: 'POST',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');

      // Throw with the HTTP status in the message so the retry helper's
      // status-pattern regex picks it up (429, 503, 504).
      throw new Error(
        `Helius getProgramAccountsV2 HTTP ${response.status}: ${text}`,
      );
    }

    const json = (await response.json()) as {
      result?: {
        accounts: Array<{ pubkey: string }>;
        paginationKey: string | null;
      };
      error?: { message?: string } | string;
    };

    if (json.error) {
      const msg =
        typeof json.error === 'string'
          ? json.error
          : (json.error.message ?? JSON.stringify(json.error));

      // Surface as Error so retry helper sees the message text and can
      // pattern-match "overloaded" / "try again" against it.
      throw new Error(msg);
    }

    if (!json.result) {
      throw new Error(
        'Helius getProgramAccountsV2: missing result field in response',
      );
    }

    const keys = json.result.accounts.map((a) => new PublicKey(a.pubkey));
    const nextKey = json.result.paginationKey ?? undefined;

    return { keys, paginationKey: nextKey || undefined };
  }

  // Non-Helius fallback — single SDK call, no pagination.
  private async fetchPageSdkV1(
    filters: Array<{ memcmp: { offset: number; bytes: string } }>,
  ): Promise<{ keys: PublicKey[]; paginationKey: undefined }> {
    const accounts = await this.solanaService.connection.getProgramAccounts(
      SPL_NAME_SERVICE_PROGRAM_ID,
      {
        dataSlice: { offset: 0, length: 0 },
        filters,
      },
    );

    return { keys: accounts.map((a) => a.pubkey), paginationKey: undefined };
  }

  private async processBatch(
    domainKeys: PublicKey[],
  ): Promise<{ attempted: number; noReverse: number }> {
    const names = await this.snsService.reverseLookupBatch(domainKeys);
    const rows: Array<Partial<DnsEntity>> = [];

    for (const [i, name] of names.entries()) {
      if (!name) {
        // Reverse PDA not found — domain has no reverse-lookup record
        // (uncommon for top-level `.sol`). Skip; reconcile cannot
        // address a row we can't name.
        continue;
      }

      rows.push({
        name: `${name}.sol`,
        node: domainKeys[i].toBase58(),
        main: 'sol',
        chain: ChainEnum.SOLANA,
      });
    }

    if (rows.length === 0) {
      return { attempted: 0, noReverse: domainKeys.length };
    }

    // `orIgnore()` → `ON CONFLICT DO NOTHING` against the unique `name`
    // index. Idempotent: replay never produces duplicates and never
    // overwrites richer rows the register / record-changes paths
    // already populated. We don't try to count post-conflict inserts —
    // TypeORM's identifier array isn't reliable across drivers.
    await this.dnsRepository
      .createQueryBuilder()
      .insert()
      .values(rows)
      .orIgnore()
      .execute();

    return {
      attempted: rows.length,
      noReverse: domainKeys.length - rows.length,
    };
  }
}
