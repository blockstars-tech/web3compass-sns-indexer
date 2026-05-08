import {
  type ConfirmedSignatureInfo,
  type Connection,
  type PublicKey,
} from '@solana/web3.js';

import { UtilsProvider } from '../../../providers/utils.provider';

export interface ISignatureWalkerOptions {
  /** Hard cap on the page size per `getSignaturesForAddress` call. */
  pageLimit: number;
  /** Bound the per-tick fetch so a backlog can't blow the rate limit. */
  maxPagesPerTick: number;
}

/**
 * Page `getSignaturesForAddress(programId)` newest-to-oldest, returning
 * every successful signature whose slot is `>= lastSlot`. Stops as soon
 * as a page crosses below the cursor or after `maxPagesPerTick`.
 *
 * Cold-start (`lastSlot === 0`) takes a single page so we don't try to
 * enumerate years of history — that's the backfill job's responsibility.
 *
 * Why `>=` rather than `>`: multiple signatures can land in the same
 * slot. Refiltering on the boundary slot is paired with idempotent
 * upserts in the caller; together they cover the edge case losslessly
 * without needing a precise signature cursor.
 */
export async function collectSignaturesSinceSlot(
  connection: Connection,
  programId: PublicKey,
  lastSlot: number,
  seedSig: string | undefined,
  options: ISignatureWalkerOptions,
): Promise<ConfirmedSignatureInfo[]> {
  const collected: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  for (let page = 0; page < options.maxPagesPerTick; page += 1) {
    const result = await UtilsProvider.retryWithExponentialBackoff(() =>
      connection.getSignaturesForAddress(programId, {
        limit: options.pageLimit,
        before,
        until: seedSig,
      }),
    );

    if (result.length === 0) {
      break;
    }

    for (const sig of result) {
      if (sig.err) {
        continue;
      }

      if (lastSlot > 0 && sig.slot < lastSlot) {
        continue;
      }

      collected.push(sig);
    }

    const oldest = result[result.length - 1];

    if (lastSlot > 0 && oldest.slot < lastSlot) {
      break;
    }

    if (lastSlot === 0) {
      // Cold start: one page only. Backfill picks up older history.
      break;
    }

    before = oldest.signature;
  }

  return collected;
}
