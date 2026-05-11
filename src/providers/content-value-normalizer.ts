/**
 * Normalize an on-chain SNS record value to its canonical content-address
 * form. Lossless extraction — anything not reducible is returned trimmed.
 *
 * Kind selects the extractors:
 *   "ipfs"    — `ipfs://` prefix + path/subdomain IPFS gateways.
 *   "ipns"    — `ipns://` prefix + path/subdomain IPNS gateways.
 *   "arweave" — `arwv://`/`ar://` prefix + arweave gateways.
 */

const WHITESPACE = /^\s+|\s+$/g;
const IPFS_PREFIX = /^ipfs:(?:\/\/)?/i;
const IPNS_PREFIX = /^ipns:(?:\/\/)?/i;
const ARWEAVE_PREFIX = /^(?:arwv|ar):(?:\/\/)?/i;
const IPFS_PATH_GATEWAY = /^https?:\/\/[^/]+\/ipfs\/([^\s#/?]+)/i;
const IPFS_SUBDOMAIN_GATEWAY = /^https?:\/\/([^\s./]+)\.ipfs\.[^\s/]+/i;
const IPNS_PATH_GATEWAY = /^https?:\/\/[^/]+\/ipns\/([^\s#/?]+)/i;
const IPNS_SUBDOMAIN_GATEWAY = /^https?:\/\/([^\s./]+)\.ipns\.[^\s/]+/i;
const ARWEAVE_GATEWAY = /^https?:\/\/[^/]+\/([\w-]{43})(?:[#/?]|$)/;
const TRAILING_SLASH = /\/+$/;
const QUERY_OR_FRAGMENT = /[#?].*$/;
const CIDV1_PREFIX = /^baf[2-7a-z]/i;

export type ContentKind = 'ipfs' | 'ipns' | 'arweave';

function extractIpfs(s: string): string {
  const subdomain = IPFS_SUBDOMAIN_GATEWAY.exec(s);

  if (subdomain) {
    return subdomain[1];
  }

  const path = IPFS_PATH_GATEWAY.exec(s);

  return path ? path[1] : s.replace(IPFS_PREFIX, '');
}

function extractIpns(s: string): string {
  const subdomain = IPNS_SUBDOMAIN_GATEWAY.exec(s);

  if (subdomain) {
    return subdomain[1];
  }

  const path = IPNS_PATH_GATEWAY.exec(s);

  return path ? path[1] : s.replace(IPNS_PREFIX, '');
}

export function normalizeContentValue(
  raw: string | null | undefined,
  kind: ContentKind,
): string {
  if (!raw) {
    return '';
  }

  let s = raw.replace(WHITESPACE, '');

  if (s.length === 0) {
    return s;
  }

  if (kind === 'ipfs') {
    s = extractIpfs(s);
  } else if (kind === 'ipns') {
    s = extractIpns(s);
  } else {
    const gateway = ARWEAVE_GATEWAY.exec(s);

    s = gateway ? gateway[1] : s.replace(ARWEAVE_PREFIX, '');
  }

  s = s.replace(QUERY_OR_FRAGMENT, '');
  s = s.replace(TRAILING_SLASH, '');

  // CIDv1 base32 is case-insensitive per spec; multiformats parsers tend to
  // be strict. Lowercasing recovers users who shift-key'd part of the CID.
  // Don't touch CIDv0 (Qm...) — base58btc IS case-sensitive.
  if (CIDV1_PREFIX.test(s) && s !== s.toLowerCase()) {
    s = s.toLowerCase();
  }

  return s.length > 0 ? s : raw.replace(WHITESPACE, '');
}

/**
 * Detect an IPNS pointer embedded in an IPFS-record value. SNS clients
 * (Brave Wallet, sns.id) treat `ipns://<key>` in an IPFS record slot as
 * an IPNS pointer. Returns the bare key, or `undefined` when not IPNS-shaped.
 */
export function detectIpnsFromIpfsValue(
  raw: string | null | undefined,
): string | undefined {
  if (!raw) {
    return undefined;
  }

  let s = raw.replace(WHITESPACE, '');

  if (s.length === 0) {
    return undefined;
  }

  // Subdomain-style IPNS gateway: <key>.ipns.<host>
  const subdomain = IPNS_SUBDOMAIN_GATEWAY.exec(s);

  if (subdomain) {
    s = subdomain[1];
  } else {
    // Path-style IPNS gateway: https://<host>/ipns/<key>
    const path = IPNS_PATH_GATEWAY.exec(s);

    if (path) {
      s = path[1];
    } else if (IPNS_PREFIX.test(s)) {
      s = s.replace(IPNS_PREFIX, '');
    } else {
      // Not IPNS-shaped — let the caller treat the value as an IPFS CID.
      return undefined;
    }
  }

  s = s.replace(QUERY_OR_FRAGMENT, '');
  s = s.replace(TRAILING_SLASH, '');

  return s.length > 0 ? s : undefined;
}
