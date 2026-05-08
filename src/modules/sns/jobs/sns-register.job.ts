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
import { BONFIDA_NAME_REGISTRAR_PROGRAM_ID } from '../../../constants/sns.constants';
import { UtilsProvider } from '../../../providers/utils.provider';
import { DnsRepository } from '../../dns/dns.repository';
import { DnsMigrationRepository } from '../../dns/dns-migration.repository';
import { ApiConfigService } from '../../shared/services/api-config.service';
import { SnsService } from '../../shared/services/sns.service';
import { SolanaService } from '../../shared/services/solana.service';
import { collectSignaturesSinceSlot } from '../lib/signature-walker';
import { extractSnsCreateMatches } from '../parsers/sns-create-instruction';

const WALKER_OPTIONS = { pageLimit: 1000, maxPagesPerTick: 5 };

/**
 * Discovers new top-level `.sol` registrations by walking the Bonfida
 * registrar's signatures since the saved slot cursor and upserting
 * skeleton rows. Content resolution is deferred to `SnsReconcileJob`,
 * which drains `cid IS NULL`. Cursor refilters on `>= lastSlot` so an
 * idempotent name-keyed upsert covers boundary-slot replays.
 */
@Injectable()
export class SnsRegisterJob {
  private isJobRunning = false;

  constructor(
    @InjectPinoLogger(SnsRegisterJob.name)
    private readonly logger: PinoLogger,
    @Inject(DnsMigrationRepository)
    private readonly dnsMigrationRepository: DnsMigrationRepository,
    @Inject(DnsRepository)
    private readonly dnsRepository: DnsRepository,
    @Inject(SolanaService)
    private readonly solanaService: SolanaService,
    @Inject(SnsService)
    private readonly snsService: SnsService,
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'sns_register' })
  async runOnSchedule(): Promise<void> {
    if (!this.configService.cronsEnabled) {
      return;
    }

    await this.handle();
  }

  async handle(): Promise<void> {
    if (this.isJobRunning) {
      this.logger.info('SNS register job already running');

      return;
    }

    this.isJobRunning = true;

    try {
      const cursor =
        await this.dnsMigrationRepository.getSnsRegisterMigrationInfo();
      const lastSlot = cursor.lastMigratedBlockNumber || 0;
      const seedSig =
        lastSlot === 0
          ? this.configService.snsCursorSeeds.registerStartedSignature
          : undefined;

      const sigs = await collectSignaturesSinceSlot(
        this.solanaService.connection,
        BONFIDA_NAME_REGISTRAR_PROGRAM_ID,
        lastSlot,
        seedSig,
        WALKER_OPTIONS,
      );

      if (sigs.length === 0) {
        this.logger.info(
          `SNS register: no new signatures since slot ${lastSlot}`,
        );

        return;
      }

      this.logger.info(
        `SNS register: processing ${sigs.length} signature(s) since slot ${lastSlot}`,
      );

      const ordered = [...sigs].sort((a, b) => a.slot - b.slot);

      let registered = 0;
      const { errors } = await PromisePool.withConcurrency(
        this.configService.snsTxFetchConcurrency,
      )
        .for(ordered)
        .process(async (sig) => {
          const count = await this.processSignature(sig);
          registered += count;
        });

      for (const err of errors) {
        this.logger.warn(
          {
            err: err.raw,
            signature: err.item.signature,
            slot: err.item.slot,
          },
          'SNS register: signature failed',
        );
      }

      // If any sig errored, hold the cursor at the slot of the lowest
      // failing sig so the next tick replays it. Idempotent name-keyed
      // upserts make re-processing the boundary safe.
      const maxSlot = ordered[ordered.length - 1].slot;
      const safeSlot =
        errors.length === 0
          ? maxSlot
          : Math.min(...errors.map((e) => e.item.slot));

      if (safeSlot > lastSlot) {
        await this.dnsMigrationRepository.saveSnsRegisterMigration({
          lastBlock: safeSlot,
          isMigrated: true,
        });
      }

      if (errors.length === 0) {
        this.logger.info(
          `SNS register: cursor advanced to slot ${safeSlot}, ${registered} domain(s) upserted`,
        );
      } else {
        this.logger.warn(
          `SNS register: ${errors.length} sig(s) failed — cursor held at slot ${safeSlot} for replay; ${registered} domain(s) upserted`,
        );
      }
    } catch (error) {
      // Pass the error object (not just .message) so pino captures the
      // stack and any nested `cause`. The JSON file logs need the
      // structured shape; .message alone hides the call site.
      this.logger.error({ err: error }, 'SNS register: tick failed');
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

    const matches = extractSnsCreateMatches(
      tx.transaction.message.instructions,
      tx.meta.innerInstructions,
    );

    if (matches.length === 0) {
      return 0;
    }

    let upserted = 0;

    for (const match of matches) {
      const ok = await this.upsertDomain(match, sig.signature);

      if (ok) {
        upserted += 1;
      }
    }

    return upserted;
  }

  private async upsertDomain(
    match: { domainPubkey: PublicKey; ownerPubkey: PublicKey },
    txSignature: string,
  ): Promise<boolean> {
    const bareName = await this.snsService.reverseLookup(match.domainPubkey);

    if (!bareName) {
      this.logger.warn(
        `SNS register: reverse-lookup miss for ${match.domainPubkey.toBase58()} (sig ${txSignature})`,
      );

      return false;
    }

    const fqdn = `${bareName}.sol`;
    const owner = match.ownerPubkey.toBase58();
    const node = match.domainPubkey.toBase58();

    // Race-safe upsert by name. Two PromisePool workers (or a concurrent
    // record-changes job) can otherwise both `findByName` → null and then
    // collide on the unique `name` index when they save. ON CONFLICT DO
    // NOTHING here means whichever insert lost still resolves cleanly;
    // the subsequent findByName always returns the winning row.
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

    const row = await this.dnsRepository.findByName(fqdn);

    if (!row) {
      this.logger.warn(
        `SNS register: failed to load row after upsert for ${fqdn}`,
      );

      return false;
    }

    let dirty = false;

    // Backfill any fields the conflicting row was missing. Don't overwrite
    // a populated `setupTxHash` — record-changes may already have stamped
    // a more recent V2-record-write sig there.
    if (!row.setupTxHash) {
      row.setupTxHash = txSignature;
      dirty = true;
    }

    if (row.ownerAddress !== owner) {
      row.ownerAddress = owner;
      row.address = owner;
      dirty = true;
    }

    if (!row.node) {
      row.node = node;
      dirty = true;
    }

    if (row.chain !== ChainEnum.SOLANA) {
      row.chain = ChainEnum.SOLANA;
      dirty = true;
    }

    if (!row.main) {
      row.main = 'sol';
      dirty = true;
    }

    if (dirty) {
      await this.dnsRepository.save(row);
    }

    return true;
  }
}
