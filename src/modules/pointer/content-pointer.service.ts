/* eslint-disable unicorn/no-null -- `null` is the TypeORM-idiomatic clear sentinel for nullable columns */
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import {
  type ContentPointerEntity,
  PointerKind,
  PointerState,
} from './content-pointer.entity';
import { ContentPointerRepository } from './content-pointer.repository';

/**
 * Maps an ENS contenthash codec string to our PointerKind enum.
 * Returns `null` for codecs that are immutable (ipfs-ns) or unsupported,
 * meaning "this row does not need a pointer".
 *
 * Codec strings come from `@ensdomains/content-hash` `getCodec`:
 *   ipfs-ns, ipns-ns, swarm-ns, onion, onion3, skynet-ns, arweave-ns, ...
 */
export function pointerKindFromContentType(
  contentType: string | null | undefined,
): PointerKind | null {
  if (!contentType) {
    return null;
  }

  const t = contentType.toLowerCase();

  if (t.includes('ipns')) {
    return PointerKind.IPNS;
  }

  if (t.includes('swarm')) {
    return PointerKind.SWARM_FEED;
  }

  if (t.includes('dnslink')) {
    return PointerKind.DNSLINK;
  }

  // ipfs-ns is intentionally not mapped — it's already an anchor.
  // skynet-ns / onion / arweave-ns: no resolver yet, skip.
  return null;
}

@Injectable()
export class ContentPointerService {
  constructor(
    @InjectPinoLogger(ContentPointerService.name)
    private readonly logger: PinoLogger,
    @Inject(ContentPointerRepository)
    private readonly repo: ContentPointerRepository,
  ) {}

  /**
   * Insert or update the pointer for a dns row. If `pointerValue` changed
   * (re-registration to a different IPNS key), scheduling state is reset
   * — the pointer is treated as new. No history is kept, matching the
   * "no versions" decision.
   */
  async upsert(input: {
    dnsId: string;
    kind: PointerKind;
    pointerValue: string;
  }): Promise<ContentPointerEntity> {
    const existing = await this.repo.findOneBy({ dnsId: input.dnsId });

    if (existing && existing.pointerValue === input.pointerValue) {
      // Same pointer, no-op (avoid stomping live scheduling state).
      this.logger.info(
        `Pointer no-op for dns ${input.dnsId} (kind=${input.kind}, value=${input.pointerValue})`,
      );

      return existing;
    }

    if (existing) {
      this.logger.info(
        `Pointer for dns ${input.dnsId} changed: ${existing.pointerValue} -> ${input.pointerValue}, resetting`,
      );

      existing.kind = input.kind;
      existing.pointerValue = input.pointerValue;
      existing.currentAnchor = null;
      existing.currentAnchorKind = null;
      existing.currentAnchorFirstSeen = null;
      existing.lastChangedAt = null;
      existing.anchorDirty = false;
      existing.nextResolveAt = new Date();
      existing.lastResolvedAt = null;
      existing.ttlObservedSeconds = null;
      existing.observedIntervalsSec = [];
      existing.resolveFailStreak = 0;
      existing.lastResolveError = null;
      existing.state = PointerState.COLD;

      return this.repo.save(existing);
    }

    this.logger.info(
      `Pointer created for dns ${input.dnsId} (kind=${input.kind}, value=${input.pointerValue})`,
    );

    return this.repo.save(
      this.repo.create({
        dnsId: input.dnsId,
        kind: input.kind,
        pointerValue: input.pointerValue,
        anchorDirty: false,
        nextResolveAt: new Date(),
        observedIntervalsSec: [],
        resolveFailStreak: 0,
        state: PointerState.COLD,
      }),
    );
  }

  async deleteByDnsId(dnsId: string): Promise<void> {
    const result = await this.repo.delete({ dnsId });

    if (result.affected && result.affected > 0) {
      this.logger.info(
        `Pointer deleted for dns ${dnsId} (rows=${result.affected})`,
      );
    }
  }

  /**
   * Idempotent reconcile: given a dns row's current contentType + cid,
   * either upsert a pointer (mutable kind) or delete any existing one
   * (now-immutable kind / no contentType / cleared cid).
   *
   * This is the single entry point listener-side. Call it after any save
   * that may have changed contentType or cid.
   */
  async syncFromDns(args: {
    dnsId: string;
    contentType: string | null | undefined;
    cid: string | null | undefined;
  }): Promise<void> {
    const kind = pointerKindFromContentType(args.contentType);

    this.logger.info(
      `syncFromDns dns=${args.dnsId} contentType=${
        args.contentType ?? 'null'
      } cid=${args.cid ?? 'null'} -> kind=${kind ?? 'none'}`,
    );

    if (!kind || !args.cid) {
      // Either it's not a mutable kind, or cid was cleared. Make sure no
      // stale pointer row lingers (e.g. a domain re-pointed from ipns-ns
      // to ipfs-ns, or contentHash was cleared on-chain).
      await this.deleteByDnsId(args.dnsId);

      return;
    }

    await this.upsert({
      dnsId: args.dnsId,
      kind,
      pointerValue: args.cid,
    });
  }
}
