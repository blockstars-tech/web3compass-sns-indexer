/* eslint-disable unicorn/no-null -- TypeORM-idiomatic clear sentinel for nullable columns */
import {
  MAX_IPFS_FETCH_RETRY_ATTEMPTS,
  StatusCodes,
} from '../../../constants/dns.constants';
import { type IResolvedContent } from '../../shared/services/sns.service';

/**
 * The subset of `DnsEntity` the reconcile state machine reads or mutates.
 * Decoupled from the TypeORM entity so this module — and the unit tests
 * around it — never pulls in the entity decorator graph.
 *
 * `needsReindex` is intentionally absent: it's a manual admin-trigger flag
 * (set by `prepareIndexedRecordsForReindexing` in the downstream content-indexer), not part of
 * any internal SNS workflow. The SNS reconcile queue is selected by
 * `cid IS NULL` instead.
 */
export interface IReconcilableDnsRow {
  id: string;
  name: string;
  cid?: string | null;
  contentType?: string | null;
  ipfsFetchStatus?: number;
  ipfsProcessed?: boolean;
  isFetchFailed?: boolean;
  ipfsFetchAttempt?: number;
  attempt?: number;
  cidProcessingId?: string | null;
  isPrimary?: boolean;
}

export interface IReconcileSideEffects {
  handleCidChange(row: IReconcilableDnsRow, oldCid: string): Promise<void>;
  saveRow(row: IReconcilableDnsRow): Promise<IReconcilableDnsRow>;
  createDnsSettings(row: IReconcilableDnsRow): Promise<unknown>;
  syncFromDns(args: {
    dnsId: string;
    contentType: string | null | undefined;
    cid: string | null | undefined;
  }): Promise<void>;
}

/**
 * Apply a resolution result to a dns row. Mirrors the EVM content-change
 * jobs (`updateEnsContent`, `updateUnsContent`, `updateDnsContentHash` in
 * `web3compassapi/src/modules/dns/dns.service.ts`) so downstream readers
 * see one consistent shape across chains.
 *
 * Audit row (`createDnsSettings`) and pointer sync (`syncFromDns`) fire
 * **only on cid-change paths**, matching the EVM convention. A successful
 * re-resolution that returns the same CID is a no-op on those side effects.
 *
 * `ipfsProcessed=false` on a new CID is the signal the downstream content-indexer uses to queue
 * the row for indexing (`dns.repository.ts:62` filters
 * `ipfs_processed=false`). Setting it to `true` means "no IPFS work to do"
 * — used on miss paths.
 *
 * Paths:
 *   hit (new cid)        → handleCidChange (if oldCid) + write new cid +
 *                           reset retry counters + ipfsProcessed=false +
 *                           SUCCESS + createDnsSettings + syncFromDns
 *   hit (cid same)       → SUCCESS + reset miss counters; NO audit, NO
 *                           sync (state didn't change)
 *   miss (had cid)       → handleCidChange + null cid/contentType + FAILED
 *                           + ipfsProcessed=true + createDnsSettings +
 *                           syncFromDns (deletes pointer)
 *   miss (no prior cid)  → FAILED + increment ipfsFetchAttempt + flip
 *                           isFetchFailed once attempts ≥ MAX; NO audit,
 *                           NO sync (no state to record)
 */
export async function applyResolution(
  row: IReconcilableDnsRow,
  result: IResolvedContent,
  effects: IReconcileSideEffects,
): Promise<void> {
  const oldCid = row.cid ?? null;
  const newCid = result.cid ?? null;

  if (newCid && result.contentType) {
    if (newCid !== oldCid) {
      // Hit — new or changed cid. Detach from old CID group, write new
      // cid, reset retry counters, hand off to the downstream content-indexer via
      // ipfsProcessed=false.
      if (oldCid) {
        await effects.handleCidChange(row, oldCid);
      }

      row.cid = newCid;
      row.contentType = result.contentType;
      row.attempt = 0;
      row.ipfsFetchAttempt = 0;
      row.isFetchFailed = false;
      row.ipfsFetchStatus = StatusCodes.SUCCESS;
      row.ipfsProcessed = false;

      const saved = await effects.saveRow(row);

      await effects.createDnsSettings(saved);
      await effects.syncFromDns({
        dnsId: saved.id,
        contentType: saved.contentType,
        cid: saved.cid,
      });
    } else {
      // Hit — same cid. Resolution succeeded but nothing changed on-chain.
      // Mirror EVM's "no-change" exit: refresh status flags, but do not
      // write an audit row or resync the pointer. `ipfsProcessed` is owned
      // by the downstream content-indexer on this path.
      row.ipfsFetchStatus = StatusCodes.SUCCESS;
      row.ipfsFetchAttempt = 0;
      row.isFetchFailed = false;

      await effects.saveRow(row);
    }

    return;
  }

  // MISS
  const newAttempt = (row.ipfsFetchAttempt ?? 0) + 1;
  const isExhausted = newAttempt >= MAX_IPFS_FETCH_RETRY_ATTEMPTS;

  if (oldCid) {
    // Domain previously had content that's no longer resolvable. Mirror
    // `updateUnsContent`'s null-cid branch: detach, clear cid/contentType,
    // audit, and delete the pointer.
    await effects.handleCidChange(row, oldCid);

    row.cid = null;
    row.contentType = null;
    row.ipfsFetchStatus = StatusCodes.FAILED;
    row.ipfsFetchAttempt = newAttempt;
    row.isFetchFailed = isExhausted;
    row.ipfsProcessed = true;

    const saved = await effects.saveRow(row);

    await effects.createDnsSettings(saved);
    await effects.syncFromDns({
      dnsId: saved.id,
      contentType: null,
      cid: null,
    });

    return;
  }

  // Miss — no prior cid. Track the resolution attempt; never had content,
  // so there is no audit row to write and no pointer to delete.
  row.cid = null;
  row.contentType = null;
  row.ipfsFetchStatus = StatusCodes.FAILED;
  row.ipfsFetchAttempt = newAttempt;
  row.isFetchFailed = isExhausted;
  row.ipfsProcessed = true;

  await effects.saveRow(row);
}
