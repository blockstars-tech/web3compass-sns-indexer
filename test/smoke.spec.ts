import { describe, expect, it } from 'vitest';

import { ChainEnum } from '../src/constants/chain.enum';
import { normalizeOwnerAddress } from '../src/providers/address-normalizer';

describe('bootstrap smoke', () => {
  it('exports ChainEnum with the upstream values', () => {
    expect(ChainEnum.ETH).toBe('ethereum');
    expect(ChainEnum.POLYGON).toBe('polygon');
    expect(ChainEnum.BSC).toBe('bsc');
  });

  it('normalizeOwnerAddress lowercases EVM but preserves Solana base58', () => {
    expect(normalizeOwnerAddress(ChainEnum.ETH, '0xABCdef')).toBe('0xabcdef');
    expect(normalizeOwnerAddress(ChainEnum.SOLANA, 'BasE58CASEsensitive')).toBe(
      'BasE58CASEsensitive',
    );
    expect(normalizeOwnerAddress(ChainEnum.ETH, undefined)).toBeUndefined();
  });
});
