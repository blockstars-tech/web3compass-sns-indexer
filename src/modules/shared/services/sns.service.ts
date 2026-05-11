import { Record as SnsRecordsAccount } from '@bonfida/sns-records';
import {
  deserializeRecordV2Content,
  deserializeReverse,
  ETH_ROA_RECORDS,
  getDomainKeySync,
  getRecord,
  getRecordV2Key,
  getReverseKeyFromDomainKey,
  GUARDIANS,
  NameRegistryState,
  Record as SnsRecord,
  SELF_SIGNED,
  Validation,
} from '@bonfida/spl-name-service';
import { Inject, Injectable } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { ContentType } from '../../../constants/sns.constants';
import {
  type ContentKind,
  detectIpnsFromIpfsValue,
  normalizeContentValue,
} from '../../../providers/content-value-normalizer';
import { UtilsProvider } from '../../../providers/utils.provider';
import { type IRecordReadResult, type IResolvedContent } from './sns.types';
import { SolanaService } from './solana.service';

const MISSING_ACCOUNT_HINTS = [
  'could not find',
  'not found',
  'does not exist',
  'account does not exist',
];

function isMissingAccountError(error: unknown): boolean {
  const msg = (error as Error)?.message?.toLowerCase?.() ?? '';

  return MISSING_ACCOUNT_HINTS.some((hint) => msg.includes(hint));
}

function recordKind(record: SnsRecord): ContentKind | undefined {
  if (record === SnsRecord.IPFS) {
    return 'ipfs';
  }

  if (record === SnsRecord.IPNS) {
    return 'ipns';
  }

  if (record === SnsRecord.ARWV) {
    return 'arweave';
  }

  return undefined;
}

function contentTypeForKind(kind: ContentKind): ContentType {
  if (kind === 'ipfs') {
    return ContentType.IPFS;
  }

  if (kind === 'ipns') {
    return ContentType.IPNS;
  }

  return ContentType.ARWEAVE;
}

/**
 * SNS resolver. Resolution order:
 *   V2-IPFS → V1-IPFS → V2-IPNS → V1-IPNS → V2-ARWV → V1-ARWV → none.
 *
 * First hit wins. A V2 record whose ROA or staleness verification fails is
 * treated as MISSING; empty/null-byte payloads likewise. Owner reads bypass
 * the SDK's `getTokenLargestAccounts` round-trip (unreliable on some RPC
 * providers) by reading the registry account directly.
 */
@Injectable()
export class SnsService {
  constructor(
    @InjectPinoLogger(SnsService.name) private readonly logger: PinoLogger,
    @Inject(SolanaService) private readonly solanaService: SolanaService,
  ) {}

  async resolveContent(name: string): Promise<IResolvedContent> {
    const v2Ipfs = await this.tryRecordV2(name, SnsRecord.IPFS);

    if (v2Ipfs) {
      return {
        cid: v2Ipfs.value,
        contentType: v2Ipfs.contentType,
        source: 'v2-ipfs',
        roaVerified: true,
      };
    }

    const v1Ipfs = await this.tryRecordV1(name, SnsRecord.IPFS);

    if (v1Ipfs) {
      return {
        cid: v1Ipfs.value,
        contentType: v1Ipfs.contentType,
        source: 'v1-ipfs',
      };
    }

    const v2Ipns = await this.tryRecordV2(name, SnsRecord.IPNS);

    if (v2Ipns) {
      return {
        cid: v2Ipns.value,
        contentType: v2Ipns.contentType,
        source: 'v2-ipns',
        roaVerified: true,
      };
    }

    const v1Ipns = await this.tryRecordV1(name, SnsRecord.IPNS);

    if (v1Ipns) {
      return {
        cid: v1Ipns.value,
        contentType: v1Ipns.contentType,
        source: 'v1-ipns',
      };
    }

    const v2Arwv = await this.tryRecordV2(name, SnsRecord.ARWV);

    if (v2Arwv) {
      return {
        cid: v2Arwv.value,
        contentType: v2Arwv.contentType,
        source: 'v2-arwv',
        roaVerified: true,
      };
    }

    const v1Arwv = await this.tryRecordV1(name, SnsRecord.ARWV);

    if (v1Arwv) {
      return {
        cid: v1Arwv.value,
        contentType: v1Arwv.contentType,
        source: 'v1-arwv',
      };
    }

    return {};
  }

  /**
   * Classify raw record bytes into `{value, contentType}`. `slotKind` is the
   * Bonfida slot we read from; the returned `contentType` is the *actual*
   * classification — they can differ when an IPFS slot embeds `ipns://...`
   * (SNS-client convention), in which case we return `ContentType.IPNS`.
   */
  private classifyRecordContent(
    rawValue: string,
    record: SnsRecord,
  ): IRecordReadResult | undefined {
    const slotKind = recordKind(record);

    if (!slotKind) {
      return undefined;
    }

    const sanitized = UtilsProvider.sanitizeCID(rawValue);

    if (slotKind === 'ipfs') {
      const ipnsKey = detectIpnsFromIpfsValue(sanitized);

      if (ipnsKey) {
        return { value: ipnsKey, contentType: ContentType.IPNS };
      }
    }

    const normalized = normalizeContentValue(sanitized, slotKind);

    if (normalized.length === 0) {
      return undefined;
    }

    return { value: normalized, contentType: contentTypeForKind(slotKind) };
  }

  /**
   * Read a V2 record. Returns the deserialized payload only when ROA +
   * staleness both verify; returns `undefined` for missing-account or
   * verification-failed cases.
   *
   * **Why we don't call `getRecordV2` from the SDK:** that function does
   * `Promise.all([NameRegistryState.retrieve(domainKey), Record.retrieve(recordKey)])`,
   * and `NameRegistryState.retrieve` calls `getTokenLargestAccounts` to
   * detect NFT-wrapped owners. That RPC method **fails on free-tier
   * Alchemy** ("failed to get token largest accounts: Internal error")
   * and gets pattern-matched as transient by our retry helper, so every
   * V2 read burns ~6 retries × 4 record reads × every reconcile row.
   *
   * The fix mirrors the workaround already in `getOwner` /
   * `reverseLookup`: read the domain account via direct `getAccountInfo`
   * + `NameRegistryState.deserialize`, skip the NFT-wrap detection (we
   * don't index wrapped owners anyway), then assemble the same
   * `verified.staleness` / `verified.roa` shape ourselves using the
   * SDK's lower-level pieces (`getRecordV2Key`, `Record.deserialize`,
   * `Validation`, `ETH_ROA_RECORDS`, `SELF_SIGNED`, `GUARDIANS`).
   *
   * Net effect on free tier: V2 resolution stops failing on every row,
   * and we save 1 RPC per V2 read (no `getTokenLargestAccounts`).
   */
  private async tryRecordV2(
    name: string,
    record: SnsRecord,
  ): Promise<IRecordReadResult | undefined> {
    let domainKey: PublicKey;
    let recordKey: PublicKey;

    try {
      domainKey = getDomainKeySync(name).pubkey;
      recordKey = getRecordV2Key(name, record);
    } catch (error) {
      // Bad input (malformed name) — not transient, not a record miss.
      this.logger.warn(
        `V2 ${record} key derivation failed for ${name}: ${(error as Error).message}`,
      );

      return undefined;
    }

    try {
      // Both reads are pure `getAccountInfo` calls under the hood —
      // safe on every Solana RPC provider. Run them in parallel like
      // the SDK does.
      const [domainInfo, recordInfo] =
        await UtilsProvider.retryWithExponentialBackoff(() =>
          this.solanaService.connection.getMultipleAccountsInfo([
            domainKey,
            recordKey,
          ]),
        );

      if (!domainInfo) {
        // The domain itself doesn't exist on-chain. Caller will handle.
        return undefined;
      }

      if (!recordInfo) {
        // No V2 record set for this domain+kind. Legit miss — fall through.
        return undefined;
      }

      const registry = NameRegistryState.deserialize(domainInfo.data);
      const retrievedRecord = SnsRecordsAccount.deserialize(recordInfo.data);

      // Replicate the SDK's verification logic from `getRecordV2`.
      // Skipping NFT-wrapped owner — registry.owner is the canonical
      // signer for indexing.
      const owner = registry.owner;
      const stalenessId = retrievedRecord.getStalenessId();

      const isStalenessValid =
        owner.equals(new PublicKey(stalenessId)) &&
        // Header validation field comes from the Bonfida SDK's nested enum;
        // strict cross-enum-type checking can't see they unify here.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
        retrievedRecord.header.stalenessValidation === Validation.Solana;

      const validation = ETH_ROA_RECORDS.has(record)
        ? Validation.Ethereum
        : Validation.Solana;

      const expectedRoaContent = SELF_SIGNED.has(record)
        ? retrievedRecord.getContent()
        : GUARDIANS.get(record)?.toBuffer();

      const roaId = retrievedRecord.getRoAId();
      const isRoaValid =
        expectedRoaContent === undefined ||
        (expectedRoaContent.compare(roaId) === 0 &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
          retrievedRecord.header.rightOfAssociationValidation === validation);

      if (!isStalenessValid || !isRoaValid) {
        this.logger.debug(
          `V2 ${record} for ${name}: staleness=${isStalenessValid} roa=${isRoaValid} — treating as missing`,
        );

        return undefined;
      }

      const content = retrievedRecord.getContent();

      if (!content || content.length === 0) {
        return undefined;
      }

      return this.classifyRecordContent(
        deserializeRecordV2Content(content, record),
        record,
      );
    } catch (error) {
      if (isMissingAccountError(error)) {
        // Legitimate "no V2 record set" signal — fall through to V1.
        return undefined;
      }

      // Anything else (post-retry 429, RPC down, malformed response) is a
      // *transient* failure. Propagate so the caller (reconcile or
      // record-changes) treats the whole sig/row as failed and retries on
      // the next tick. Swallowing here would cause `resolveContent` to
      // return `{}` and `applyResolution` to then clear a perfectly valid
      // CID from the dns row — silent data loss on RPC outages.
      this.logger.warn(
        `V2 ${record} read failed for ${name} (transient, will retry): ${(error as Error).message}`,
      );

      throw error;
    }
  }

  /**
   * Read a V1 record. V1 records have no ROA; we trust whatever is on-chain.
   */
  private async tryRecordV1(
    name: string,
    record: SnsRecord,
  ): Promise<IRecordReadResult | undefined> {
    try {
      const content = await UtilsProvider.retryWithExponentialBackoff(() =>
        getRecord(this.solanaService.connection, name, record, true),
      );

      if (!content) {
        return undefined;
      }

      return this.classifyRecordContent(content, record);
    } catch (error) {
      if (isMissingAccountError(error)) {
        // Legitimate "no V1 record set" — fall through.
        return undefined;
      }

      // Transient failure — propagate so reconcile retries the row next
      // tick rather than clearing the cid based on a flaky RPC. See the
      // matching comment in `tryRecordV2`.
      this.logger.warn(
        `V1 ${record} read failed for ${name} (transient, will retry): ${(error as Error).message}`,
      );

      throw error;
    }
  }

  /**
   * Get the current registry owner of a `.sol` domain. Returns raw base58
   * (Solana addresses are case-sensitive — never lowercased). Skips the
   * NFT-wrapped-owner lookup; for indexing the registry owner is the
   * canonical signer for ROA verification.
   */
  async getOwner(name: string): Promise<string | undefined> {
    let pubkey: PublicKey;

    try {
      ({ pubkey } = getDomainKeySync(name));
    } catch (error) {
      // Bad input (malformed name) — not transient, no point in retrying.
      this.logger.warn(
        `getOwner invalid name ${name}: ${(error as Error).message}`,
      );

      return undefined;
    }

    // RPC call: errors propagate so callers can decide whether to retry
    // (matches `tryRecordV2` / `tryRecordV1`). The retry helper inside
    // already covers 429s and 5xx; anything that escapes is transient
    // enough to warrant a job-level replay.
    const accountInfo = await UtilsProvider.retryWithExponentialBackoff(() =>
      this.solanaService.connection.getAccountInfo(pubkey),
    );

    if (!accountInfo) {
      // Legit: domain account doesn't exist on-chain.
      return undefined;
    }

    try {
      const registry = NameRegistryState.deserialize(accountInfo.data);

      return registry.owner.toBase58();
    } catch (error) {
      // Corrupted account data — treat as missing rather than retrying.
      this.logger.warn(
        `getOwner deserialize failed for ${name}: ${(error as Error).message}`,
      );

      return undefined;
    }
  }

  /**
   * Reverse-lookup a domain account pubkey to its `.sol` name.
   *
   * Uses direct `getAccountInfo` on the reverse PDA + manual
   * `deserializeReverse`, bypassing the SDK's `NameRegistryState.retrieve`
   * (which makes an additional `getTokenLargestAccounts` call that some
   * RPC providers don't reliably serve).
   */
  async reverseLookup(
    accountPubkey: PublicKey | string,
  ): Promise<string | undefined> {
    let pubkey: PublicKey;
    let reverseKey: PublicKey;

    try {
      pubkey =
        typeof accountPubkey === 'string'
          ? new PublicKey(accountPubkey)
          : accountPubkey;
      reverseKey = getReverseKeyFromDomainKey(pubkey);
    } catch (error) {
      // Bad pubkey input — not transient.
      this.logger.warn(
        `reverseLookup invalid input ${String(accountPubkey)}: ${(error as Error).message}`,
      );

      return undefined;
    }

    // RPC call: errors propagate (see `getOwner`/`tryRecordV2`).
    const accountInfo = await UtilsProvider.retryWithExponentialBackoff(() =>
      this.solanaService.connection.getAccountInfo(reverseKey),
    );

    if (!accountInfo) {
      // Legit: no reverse-lookup PDA exists for this domain.
      return undefined;
    }

    const reverseData = accountInfo.data.slice(NameRegistryState.HEADER_LEN);

    if (reverseData.length === 0) {
      return undefined;
    }

    try {
      return deserializeReverse(reverseData);
    } catch (error) {
      this.logger.warn(
        `reverseLookup deserialize failed for ${pubkey.toBase58()}: ${(error as Error).message}`,
      );

      return undefined;
    }
  }

  /**
   * Batched reverseLookup. For backfill of 500k+ domains, the per-key
   * `reverseLookup` is prohibitively slow — this collapses each chunk of
   * up to 100 domain pubkeys into a single `getMultipleAccountsInfo` RPC.
   *
   * Returns an array aligned 1:1 with `domainPubkeys`. Indices where the
   * reverse PDA didn't exist (or was empty) come back as `undefined`.
   */
  async reverseLookupBatch(
    domainPubkeys: PublicKey[],
  ): Promise<Array<string | undefined>> {
    if (domainPubkeys.length === 0) {
      return [];
    }

    const reverseKeys = domainPubkeys.map((pk) =>
      getReverseKeyFromDomainKey(pk),
    );

    // `getMultipleAccountsInfo` accepts up to 100 keys per call.
    const CHUNK = 100;
    const out: Array<string | undefined> = Array.from({
      length: domainPubkeys.length,
    });

    for (let offset = 0; offset < reverseKeys.length; offset += CHUNK) {
      const slice = reverseKeys.slice(offset, offset + CHUNK);

      // RPC errors propagate so backfill aborts cleanly without saving the
      // batch cursor (rather than silently dropping every domain in the
      // chunk). The next backfill resume will retry the same batch.
      // eslint-disable-next-line no-await-in-loop
      const infos = await UtilsProvider.retryWithExponentialBackoff(() =>
        this.solanaService.connection.getMultipleAccountsInfo(slice),
      );

      for (const [i, info] of infos.entries()) {
        if (!info) {
          out[offset + i] = undefined;
          continue;
        }

        const reverseData = info.data.slice(NameRegistryState.HEADER_LEN);

        if (reverseData.length === 0) {
          out[offset + i] = undefined;
          continue;
        }

        try {
          out[offset + i] = deserializeReverse(reverseData);
        } catch {
          out[offset + i] = undefined;
        }
      }
    }

    return out;
  }
}
