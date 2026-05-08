import { describe, expect, it } from 'vitest';

import { normalizeContentValue } from '../../src/providers/content-value-normalizer';

describe('normalizeContentValue (ipfs)', () => {
  it('passes a bare CIDv0 (Qm...) through unchanged', () => {
    const cid = 'QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM';
    expect(normalizeContentValue(cid, 'ipfs')).toBe(cid);
  });

  it('passes a bare CIDv1 (bafy...) through unchanged', () => {
    const cid = 'bafybeibyhzh2avzzyutxdvvzb5mlk6nxfyvuh2ws2e5ehr6nyf7cgmu5de';
    expect(normalizeContentValue(cid, 'ipfs')).toBe(cid);
  });

  it('passes a bare CIDv1 (bafkrei...) through unchanged', () => {
    const cid = 'bafkreibf7zg3hzqhbosz5f3za2nakabn35fo54chhq5qbupunll322qevi';
    expect(normalizeContentValue(cid, 'ipfs')).toBe(cid);
  });

  it('strips the ipfs:// prefix', () => {
    expect(
      normalizeContentValue(
        'ipfs://bafybeia62347apcmaznpr3smnim6jq74ipepzd7ov5vwzekdipryv3oixe',
        'ipfs',
      ),
    ).toBe('bafybeia62347apcmaznpr3smnim6jq74ipepzd7ov5vwzekdipryv3oixe');
  });

  it('strips the ipfs: prefix without slashes', () => {
    expect(
      normalizeContentValue('ipfs:QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM', 'ipfs'),
    ).toBe('QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM');
  });

  it('extracts CID from a path-style ipfs.io gateway URL', () => {
    expect(
      normalizeContentValue(
        'https://ipfs.io/ipfs/QmQDBnT8Jm45HoAwUwZ6378opH43AfiCSWS6sEvL256h94/',
        'ipfs',
      ),
    ).toBe('QmQDBnT8Jm45HoAwUwZ6378opH43AfiCSWS6sEvL256h94');
  });

  it('extracts CID from a path-style gateway URL with deeper path', () => {
    expect(
      normalizeContentValue('https://ipfs.io/ipfs/bafybeicdef.../wiki/Page', 'ipfs'),
    ).toBe('bafybeicdef...');
  });

  it('extracts CID from a subdomain-style gateway URL', () => {
    expect(
      normalizeContentValue(
        'https://bafybeicdef123.ipfs.dweb.link/path',
        'ipfs',
      ),
    ).toBe('bafybeicdef123');
  });

  it('strips trailing slash on a bare CID', () => {
    expect(
      normalizeContentValue(
        'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/',
        'ipfs',
      ),
    ).toBe('QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco');
  });

  it('strips trailing query string', () => {
    expect(
      normalizeContentValue(
        'https://ipfs.io/ipfs/QmFoo?filename=bar.html',
        'ipfs',
      ),
    ).toBe('QmFoo');
  });

  it('strips trailing fragment', () => {
    expect(normalizeContentValue('QmFoo#section', 'ipfs')).toBe('QmFoo');
  });

  it('trims leading and trailing whitespace including tabs', () => {
    expect(
      normalizeContentValue('\t  QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM \n', 'ipfs'),
    ).toBe('QmdrgT7AsRS19dpvAC7nVHX3uLE4gpJTvsRHcm9CnyBVCM');
  });

  it('lowercases a mixed-case CIDv1 (recovers shift-key typos)', () => {
    expect(
      normalizeContentValue(
        'bafybeifhplzmn52r2fspeu76k6hspinpogvtkaozau67vvphfx6Inz5wfa',
        'ipfs',
      ),
    ).toBe('bafybeifhplzmn52r2fspeu76k6hspinpogvtkaozau67vvphfx6inz5wfa');
  });

  it('does NOT lowercase a CIDv0 (base58btc is case-sensitive)', () => {
    const cid = 'QmXJWMGrWPt5Zm5e7S7DJH6oYaNmAHDGgoWgibBqDRJzSa';
    expect(normalizeContentValue(cid, 'ipfs')).toBe(cid);
  });

  it('passes through HTTP URLs that do not match a gateway pattern', () => {
    const url = 'https://raw.githubusercontent.com/SFMSOL/SFM-ICON/main/IMG_0337.PNG';
    expect(normalizeContentValue(url, 'ipfs')).toBe(url);
  });

  it('passes through a domain-reference style garbage value', () => {
    expect(normalizeContentValue('greystormdigital.nft', 'ipfs')).toBe(
      'greystormdigital.nft',
    );
  });

  it('passes through a literal placeholder value', () => {
    expect(normalizeContentValue('Scorpi', 'ipfs')).toBe('Scorpi');
  });

  it('returns empty string for null / undefined / empty input', () => {
    expect(normalizeContentValue(null, 'ipfs')).toBe('');
    expect(normalizeContentValue(undefined, 'ipfs')).toBe('');
    expect(normalizeContentValue('', 'ipfs')).toBe('');
    expect(normalizeContentValue('   ', 'ipfs')).toBe('');
  });

  it('does not mistake a generic .ipfs.tld string for a subdomain gateway without scheme', () => {
    expect(normalizeContentValue('bafy.ipfs.dweb.link', 'ipfs')).toBe(
      'bafy.ipfs.dweb.link',
    );
  });
});

describe('normalizeContentValue (arweave)', () => {
  it('strips the arwv:// prefix', () => {
    expect(
      normalizeContentValue(
        'arwv://HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE',
        'arweave',
      ),
    ).toBe('HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE');
  });

  it('strips the ar:// prefix', () => {
    expect(
      normalizeContentValue(
        'ar://HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE',
        'arweave',
      ),
    ).toBe('HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE');
  });

  it('passes a bare 43-char Arweave tx ID through unchanged', () => {
    const tx = 'M6RjlU_DgKRNQzAIqngyJmj7rJFYgnJLaCY6xNm3uc4';
    expect(normalizeContentValue(tx, 'arweave')).toBe(tx);
  });

  it('extracts tx ID from arweave.net path-style URL', () => {
    expect(
      normalizeContentValue(
        'https://arweave.net/HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE',
        'arweave',
      ),
    ).toBe('HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE');
  });

  it('extracts tx ID from arweave.net URL with subpath', () => {
    expect(
      normalizeContentValue(
        'https://arweave.net/HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE/index.html',
        'arweave',
      ),
    ).toBe('HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE');
  });

  it('passes through a literal placeholder', () => {
    expect(normalizeContentValue('arwv://<HASH>', 'arweave')).toBe('<HASH>');
  });

  it('preserves uppercase letters in Arweave tx ID (not CIDv1)', () => {
    const tx = 'HnLG_0dN_iBPM8oFKMtPmzopDBqaQ7lUXZeNJahLGiE';
    expect(normalizeContentValue(tx, 'arweave')).toBe(tx);
  });
});
