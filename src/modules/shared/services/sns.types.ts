import { type ContentType } from '../../../constants/sns.constants';

export type ResolutionSource =
  | 'v2-ipfs'
  | 'v1-ipfs'
  | 'v2-ipns'
  | 'v1-ipns'
  | 'v2-arwv'
  | 'v1-arwv';

/** Result returned by `SnsService.resolveContent`. */
export interface IResolvedContent {
  cid?: string;
  contentType?: ContentType;
  source?: ResolutionSource;
  /** True only when the V2 record's ROA + staleness signatures verify. */
  roaVerified?: boolean;
}

/**
 * Resolver-internal shape. `source` (the Bonfida slot we read from) and
 * `contentType` normally agree — but an IPFS slot can hold an `ipns://`
 * pointer, in which case `contentType` is `ipns-ns`.
 */
export interface IRecordReadResult {
  value: string;
  contentType: ContentType;
}
