/**
 * Vendored from `web3compassapi/src/constants/dns.constants.ts`. Keep in sync.
 */

/** Cap retries for content resolution before flipping `isFetchFailed=true`. */
export const MAX_IPFS_FETCH_RETRY_ATTEMPTS = 3;

/** Generic processing-attempt cap (used by retry-style jobs). */
export const MAX_RETRY_ATTEMPTS = 5;

/** Domains expired by more than this many seconds with no CID may be pruned. */
export const DEFAULT_GRACE_PERIOD = 7_776_000; // 90 days

/**
 * Two-state IPFS-fetch result tracked on `dns.ipfsFetchStatus`. Matches the
 * upstream EVM jobs so downstream readers (content-indexer service) keep a
 * consistent enum across chains.
 */
export enum StatusCodes {
  SUCCESS = 0,
  FAILED = 1,
}
