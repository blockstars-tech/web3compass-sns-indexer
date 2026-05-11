import { describe, expect, it } from 'vitest';

import { isPlausiblePointerValue } from '../../src/modules/pointer/pointer-value.validator';

describe('isPlausiblePointerValue', () => {
  it('accepts a bare IPNS key', () => {
    expect(
      isPlausiblePointerValue(
        'k51qzi5uqu5dik3yxxdflyra3gxbx9qqs7atsqncf32vqlgyj0kjvogribn0n0',
      ),
    ).toBe(true);
  });

  it('accepts a bare IPFS CIDv0', () => {
    expect(
      isPlausiblePointerValue('QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM'),
    ).toBe(true);
  });

  it('accepts a bare CIDv1', () => {
    expect(
      isPlausiblePointerValue(
        'bafybeibyhzh2avzzyutxdvvzb5mlk6nxfyvuh2ws2e5ehr6nyf7cgmu5de',
      ),
    ).toBe(true);
  });

  it('accepts a bare DNSLink-style hostname', () => {
    expect(isPlausiblePointerValue('example.com')).toBe(true);
  });

  it('rejects an https:// IPNS gateway URL', () => {
    expect(isPlausiblePointerValue('https://ipfs.io/ipns/k51abc')).toBe(false);
  });

  it('rejects an https:// IPFS subdomain gateway URL', () => {
    expect(
      isPlausiblePointerValue('https://bafyabc.ipfs.dweb.link/path'),
    ).toBe(false);
  });

  it('rejects an ipns:// prefix', () => {
    expect(isPlausiblePointerValue('ipns://k51abc')).toBe(false);
  });

  it('rejects an ipns: prefix without slashes', () => {
    expect(isPlausiblePointerValue('ipns:k51abc')).toBe(false);
  });

  it('rejects an ipfs:// prefix', () => {
    expect(isPlausiblePointerValue('ipfs://QmFoo')).toBe(false);
  });

  it('rejects an ar:// arweave prefix', () => {
    expect(isPlausiblePointerValue('ar://HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE')).toBe(false);
  });

  it('rejects values containing whitespace', () => {
    expect(isPlausiblePointerValue('k51abc foo')).toBe(false);
    expect(isPlausiblePointerValue('k51abc\nfoo')).toBe(false);
    expect(isPlausiblePointerValue('k51abc\tfoo')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isPlausiblePointerValue('')).toBe(false);
  });

  it('rejects values longer than 256 chars', () => {
    expect(isPlausiblePointerValue('k'.repeat(257))).toBe(false);
  });

  it('accepts values exactly at the 256-char boundary', () => {
    expect(isPlausiblePointerValue('k'.repeat(256))).toBe(true);
  });

  it('does not false-positive a numeric-leading string (no scheme match)', () => {
    // The regex requires an alpha-leading scheme, so `2001:db8::1` is not
    // matched as a URL scheme. But the embedded colons are still suspect
    // enough that we'd reject — except the current regex won't catch this.
    // This test pins current behavior: numeric-led inputs without a scheme
    // *aren't* rejected. Tightening past this risks rejecting bare hex CIDs.
    expect(isPlausiblePointerValue('2001abc')).toBe(true);
  });
});
