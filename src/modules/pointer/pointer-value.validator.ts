// Match `scheme:` with or without `//`. Legitimate pointer values (IPNS keys,
// DNSLink hostnames, Swarm feed refs) never start with an alpha-led scheme +
// colon, so this catches both `ipns://k51...` and `ipns:k51...`.
const SCHEME_PREFIX = /^[a-z][\d+.a-z-]*:/i;
const WHITESPACE = /\s/;
const MAX_LENGTH = 256;

/**
 * Sanity-check a value about to be written to `content_pointer.pointer_value`.
 * Catches leftover scheme prefixes (`ipns://`, `https://`, …) and whitespace
 * that indicate the upstream resolver didn't classify the value cleanly.
 * Kind-specific shape validation belongs in the resolver.
 */
export function isPlausiblePointerValue(cid: string): boolean {
  if (cid.length === 0 || cid.length > MAX_LENGTH) {
    return false;
  }

  if (WHITESPACE.test(cid)) {
    return false;
  }

  return !SCHEME_PREFIX.test(cid);
}
