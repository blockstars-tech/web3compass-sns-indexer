import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
  type PublicKey,
} from '@solana/web3.js';
import { PromisePool } from '@supercharge/promise-pool';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { ChainEnum } from '../../../constants/chain.enum';
import { SNS_RECORDS_V2_PROGRAM_ID } from '../../../constants/sns.constants';
import { UtilsProvider } from '../../../providers/utils.provider';
import { CidProcessingService } from '../../dns/cid-processing/cid-processing.service';
import { type DnsEntity } from '../../dns/dns.entity';
import { DnsRepository } from '../../dns/dns.repository';
import { DnsMigrationRepository } from '../../dns/dns-migration.repository';
import { DnsSettingsService } from '../../dns/dns-settings.service';
import { ContentPointerService } from '../../pointer/content-pointer.service';
import { ApiConfigService } from '../../shared/services/api-config.service';
import { SnsService } from '../../shared/services/sns.service';
import { type IResolvedContent } from '../../shared/services/sns.types';
import { SolanaService } from '../../shared/services/solana.service';
import { collectSignaturesSinceSlot } from '../lib/signature-walker';
import { extractV2RecordDomains } from '../parsers/sns-record-instruction';
import { applyResolution } from './sns-reconcile.state';

const WALKER_OPTIONS = { pageLimit: 1000, maxPagesPerTick: 5 };

/**
 * Walks SNS Records V2 program signatures and re-resolves every dns row
 * whose record was touched, inline (mirroring EVM `updateEnsContent`).
 * V1-only domains are not walked in this version — the resolution chain
 * prefers V2 anyway. Race-safety on the unknown-domain path: `INSERT ...
 * ON CONFLICT DO NOTHING` + `findByName` re-fetch covers two workers (or
 * the register job) racing on the unique `name` index.
 */
@Injectable()
export class SnsRecordChangesJob {
  private isJobRunning = false;

  constructor(
    @InjectPinoLogger(SnsRecordChangesJob.name)
    private readonly logger: PinoLogger,
    @Inject(DnsMigrationRepository)
    private readonly dnsMigrationRepository: DnsMigrationRepository,
    @Inject(DnsRepository)
    private readonly dnsRepository: DnsRepository,
    @Inject(SolanaService)
    private readonly solanaService: SolanaService,
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

  /**
   * Cron entry. See `SnsRegisterJob.runOnSchedule` for the gating contract.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'sns_record_changes' })
  async runOnSchedule(): Promise<void> {
    if (!this.configService.cronsEnabled) {
      return;
    }

    await this.handle();
  }

  async handle(): Promise<void> {
    if (this.isJobRunning) {
      this.logger.info('SNS record-changes job already running');

      return;
    }

    this.isJobRunning = true;

    try {
      const cursor =
        await this.dnsMigrationRepository.getSnsRecordsV2UpdateMigrationInfo();
      const lastSlot = cursor.lastMigratedBlockNumber || 0;
      const seedSig =
        lastSlot === 0
          ? this.configService.snsCursorSeeds.recordsV2StartedSignature
          : undefined;

      const sigs = await collectSignaturesSinceSlot(
        this.solanaService.connection,
        SNS_RECORDS_V2_PROGRAM_ID,
        lastSlot,
        seedSig,
        WALKER_OPTIONS,
      );

      if (sigs.length === 0) {
        this.logger.info(
          `SNS record-changes: no new signatures since slot ${lastSlot}`,
        );

        return;
      }

      this.logger.info(
        `SNS record-changes: processing ${sigs.length} signature(s) since slot ${lastSlot}`,
      );

      const ordered = [...sigs].sort((a, b) => a.slot - b.slot);

      let processed = 0;
      const { errors } = await PromisePool.withConcurrency(
        this.configService.snsTxFetchConcurrency,
      )
        .for(ordered)
        .process(async (sig) => {
          const count = await this.processSignature(sig);
          processed += count;
        });

      for (const err of errors) {
        this.logger.warn(
          {
            err: err.raw,
            signature: err.item.signature,
            slot: err.item.slot,
          },
          'SNS record-changes: signature failed',
        );
      }

      // Hold cursor at lowest failing slot so the next tick replays it.
      // The race-safe upsert + idempotent applyResolution make replay safe.
      const maxSlot = ordered[ordered.length - 1].slot;
      const safeSlot =
        errors.length === 0
          ? maxSlot
          : Math.min(...errors.map((e) => e.item.slot));

      if (safeSlot > lastSlot) {
        await this.dnsMigrationRepository.saveSnsRecordsV2UpdateMigration({
          lastBlock: safeSlot,
        });
      }

      if (errors.length === 0) {
        this.logger.info(
          `SNS record-changes: cursor advanced to slot ${safeSlot}, ${processed} domain(s) processed`,
        );
      } else {
        this.logger.warn(
          `SNS record-changes: ${errors.length} sig(s) failed — cursor held at slot ${safeSlot} for replay; ${processed} domain(s) processed`,
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'SNS record-changes: tick failed');
    } finally {
      this.isJobRunning = false;
    }
  }

  private async processSignature(sig: ConfirmedSignatureInfo): Promise<number> {
    const tx: ParsedTransactionWithMeta | null =
      await UtilsProvider.retryWithExponentialBackoff(() =>
        this.solanaService.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }),
      );

    if (!tx || !tx.meta || tx.meta.err) {
      return 0;
    }

    const domains = extractV2RecordDomains(
      tx.transaction.message.instructions,
      tx.meta.innerInstructions,
    );

    if (domains.length === 0) {
      return 0;
    }

    let processed = 0;

    for (const domain of domains) {
      // eslint-disable-next-line no-await-in-loop
      const didWrite = await this.applyRecordWrite(domain, sig.signature);

      if (didWrite) {
        processed += 1;
      }
    }

    return processed;
  }

  /**
   * Find or upsert the dns row for `domain`, then resolve content inline
   * and write the result via the shared state machine.
   */
  private async applyRecordWrite(
    domain: PublicKey,
    txSignature: string,
  ): Promise<boolean> {
    const node = domain.toBase58();
    let row = await this.dnsRepository.findByNode(node);
    let bareName: string | undefined;

    if (row) {
      bareName = row.name.endsWith('.sol')
        ? row.name.slice(0, -'.sol'.length)
        : row.name;
    } else {
      // Unknown domain — reverse-lookup, then race-safe upsert by name.
      bareName = await this.snsService.reverseLookup(domain);

      if (!bareName) {
        this.logger.warn(
          `SNS record-changes: reverse-lookup miss for ${node} (sig ${txSignature})`,
        );

        return false;
      }

      const fqdn = `${bareName}.sol`;
      const owner = await this.snsService.getOwner(bareName);

      // ON CONFLICT DO NOTHING — covers two PromisePool workers (or the
      // register job) racing on the same name. Whichever insert lost
      // resolves cleanly; we re-fetch below to load whatever's there.
      await this.dnsRepository
        .createQueryBuilder()
        .insert()
        .values({
          name: fqdn,
          node,
          main: 'sol',
          chain: ChainEnum.SOLANA,
          ownerAddress: owner,
          address: owner,
          setupTxHash: txSignature,
        })
        .orIgnore()
        .execute();

      row = await this.dnsRepository.findByName(fqdn);

      if (!row) {
        this.logger.warn(
          `SNS record-changes: failed to load row after upsert for ${fqdn} (sig ${txSignature})`,
        );

        return false;
      }

      // Backfill any fields the conflicting row lacked (its node may be
      // null if the register job created it via a different code path).
      let isDirty = false;

      if (!row.node) {
        row.node = node;
        isDirty = true;
      }

      if (isDirty) {
        row = await this.dnsRepository.save(row);
      }
    }

    // Always overwrite setupTxHash with the latest V2-record-write sig.
    // Mirrors EVM `updateEnsContent`'s `dnsEntity.setupTxHash = setupTxHash`.
    if (row.setupTxHash !== txSignature) {
      row.setupTxHash = txSignature;
    }

    // Resolve content inline and apply via the shared state machine.
    const result = await this.snsService.resolveContent(bareName);

    await this.applyResolution(row, result);

    return true;
  }

  /**
   * Bridge into the pure state machine, mirroring `SnsReconcileJob`. Both
   * jobs need to apply the same write protocol when content state changes,
   * so the side-effect plumbing is the same.
   */
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
