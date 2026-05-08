import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PromisePool } from '@supercharge/promise-pool';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { ChainEnum } from '../../../constants/chain.enum';
import { CidProcessingService } from '../../dns/cid-processing/cid-processing.service';
import { type DnsEntity } from '../../dns/dns.entity';
import { DnsRepository } from '../../dns/dns.repository';
import { DnsSettingsService } from '../../dns/dns-settings.service';
import { ContentPointerService } from '../../pointer/content-pointer.service';
import { ApiConfigService } from '../../shared/services/api-config.service';
import {
  type IResolvedContent,
  type ResolutionSource,
  SnsService,
} from '../../shared/services/sns.service';
import { applyResolution } from './sns-reconcile.state';

const RECONCILE_BATCH_SIZE = 100;

type SourceKey = ResolutionSource | 'none';

const SOURCE_KEYS: SourceKey[] = [
  'v2-ipfs',
  'v1-ipfs',
  'v2-arwv',
  'v1-arwv',
  'none',
];

/**
 * Drains the first-time-resolution queue (`chain = solana AND cid IS NULL
 * AND is_fetch_failed IS NOT TRUE`) by running the V2-IPFS → V1-IPFS →
 * V2-ARWV → V1-ARWV resolution chain. Once a row has a cid it leaves the
 * queue; subsequent content changes are picked up inline by
 * `SnsRecordChangesJob`. Per-result write protocol lives in
 * `applyResolution` (see `sns-reconcile.state.ts`).
 */
@Injectable()
export class SnsReconcileJob {
  private isJobRunning = false;

  constructor(
    @InjectPinoLogger(SnsReconcileJob.name)
    private readonly logger: PinoLogger,
    @Inject(DnsRepository)
    private readonly dnsRepository: DnsRepository,
    @Inject(SnsService)
    private readonly snsService: SnsService,
    @Inject(ContentPointerService)
    private readonly contentPointerService: ContentPointerService,
    @Inject(CidProcessingService)
    private readonly cidProcessingService: CidProcessingService,
    @Inject(DnsSettingsService)
    private readonly dnsSettingsService: DnsSettingsService,
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
  ) {}

  @Cron('*/30 * * * * *', { name: 'sns_reconcile' })
  async runOnSchedule(): Promise<void> {
    if (!this.configService.cronsEnabled) {
      return;
    }

    await this.handle();
  }

  async handle(): Promise<void> {
    if (this.isJobRunning) {
      this.logger.info('SNS reconcile job already running');

      return;
    }

    this.isJobRunning = true;

    try {
      const rows = await this.dnsRepository.findUnresolved(
        ChainEnum.SOLANA,
        RECONCILE_BATCH_SIZE,
      );

      if (rows.length === 0) {
        this.logger.info('SNS reconcile: queue empty');

        return;
      }

      this.logger.info(`SNS reconcile: draining ${rows.length} row(s)`);

      // Source keys match the public `ResolutionSource` shape — kebab-case
      // to mirror SNS record-kind nomenclature.
      /* eslint-disable @typescript-eslint/naming-convention, quote-props */
      const stats: Record<SourceKey, number> = {
        'v2-ipfs': 0,
        'v1-ipfs': 0,
        'v2-arwv': 0,
        'v1-arwv': 0,
        none: 0,
      };
      /* eslint-enable @typescript-eslint/naming-convention, quote-props */

      const { errors } = await PromisePool.withConcurrency(
        this.configService.snsResolveConcurrency,
      )
        .for(rows)
        .process(async (row) => {
          const bareName = row.name.endsWith('.sol')
            ? row.name.slice(0, -'.sol'.length)
            : row.name;
          const result = await this.snsService.resolveContent(bareName);
          const key: SourceKey =
            result.cid && result.source ? result.source : 'none';
          stats[key] += 1;
          await this.applyResolution(row, result);
        });

      for (const err of errors) {
        this.logger.warn(
          { err: err.raw, name: err.item.name },
          'SNS reconcile: row failed',
        );
      }

      const summary = SOURCE_KEYS.map((k) => `${k}=${stats[k]}`).join(' ');
      this.logger.info(`SNS reconcile: ${summary}`);
    } catch (error) {
      this.logger.error({ err: error }, 'SNS reconcile: tick failed');
    } finally {
      this.isJobRunning = false;
    }
  }

  // Bridges DI services into the pure state machine so unit tests can call
  // `applyResolution` directly with mocked side-effects.
  private applyResolution(
    row: DnsEntity,
    result: IResolvedContent,
  ): Promise<void> {
    return applyResolution(row, result, {
      handleCidChange: (r, oldCid) =>
        this.cidProcessingService.handleCidChange(r as DnsEntity, oldCid),
      saveRow: (r) => this.dnsRepository.save(r as DnsEntity),
      createDnsSettings: (r) =>
        this.dnsSettingsService.createDnsSettings(r as DnsEntity),
      syncFromDns: (args) => this.contentPointerService.syncFromDns(args),
    });
  }
}
