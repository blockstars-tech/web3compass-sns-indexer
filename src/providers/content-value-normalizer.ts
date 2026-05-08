/**
 * Normalize an on-chain SNS record value to its canonical content-address
 * form. Lossless extraction only — anything that can't be reduced to a
 * plain CID / Arweave-tx is returned trimmed but otherwise untouched, so
 * downstream validation can still see the original payload.
 *
 * Kind selects the prefix and gateway-URL extractors to apply:
 *   "ipfs"    — strips `ipfs://` / `ipfs:`, extracts CID from path-style
 *               (`/ipfs/<cid>[/...]`) and subdomain-style
 *               (`<cid>.ipfs.<host>[/...]`) gateway URLs.
 *   "arweave" — strips `arwv://` / `ar://`, extracts tx ID from
 *               `<host>/<43-char-tx>[/...]` arweave gateway URLs.
 */

const WHITESPACE = /^[\s ]+|[\s ]+$/g;
const IPFS_PREFIX = /^ipfs:(?:\/\/)?/i;
const ARWEAVE_PREFIX = /^(?:arwv|ar):(?:\/\/)?/i;
const IPFS_PATH_GATEWAY = /^https?:\/\/[^/]+\/ipfs\/([^/?#\s]+)/i;
const IPFS_SUBDOMAIN_GATEWAY = /^https?:\/\/([^./\s]+)\.ipfs\.[^/\s]+/i;
const ARWEAVE_GATEWAY = /^https?:\/\/[^/]+\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/;
const TRAILING_SLASH = /\/+$/;
const QUERY_OR_FRAGMENT = /[?#].*$/;
const CIDV1_PREFIX = /^baf[a-z2-7]/i;

export type ContentKind = "ipfs" | "arweave";

export function normalizeContentValue(
  raw: string | null | undefined,
  kind: ContentKind,
): string {
  if (!raw) {
    return "";
  }

  let s = raw.replace(WHITESPACE, "");

  if (s.length === 0) {
    return s;
  }

  if (kind === "ipfs") {
    const subdomain = IPFS_SUBDOMAIN_GATEWAY.exec(s);

    if (subdomain) {
      s = subdomain[1];
    } else {
      const path = IPFS_PATH_GATEWAY.exec(s);

      if (path) {
        s = path[1];
      } else {
        s = s.replace(IPFS_PREFIX, "");
      }
    }
  } else {
    const gateway = ARWEAVE_GATEWAY.exec(s);

    if (gateway) {
      s = gateway[1];
    } else {
      s = s.replace(ARWEAVE_PREFIX, "");
    }
  }

  s = s.replace(QUERY_OR_FRAGMENT, "");
  s = s.replace(TRAILING_SLASH, "");

  // CIDv1 base32 is case-insensitive per spec; multiformats parsers tend to
  // be strict. Lowercasing recovers users who shift-key'd part of the CID.
  // Don't touch CIDv0 (Qm...) — base58btc IS case-sensitive.
  if (CIDV1_PREFIX.test(s) && s !== s.toLowerCase()) {
    s = s.toLowerCase();
  }

  return s.length > 0 ? s : raw.replace(WHITESPACE, "");
}
