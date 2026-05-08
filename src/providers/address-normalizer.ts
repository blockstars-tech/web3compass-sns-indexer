import { ChainEnum } from "../constants/chain.enum";

/**
 * Solana base58 pubkeys are case-sensitive — never lowercase them. EVM
 * addresses are case-insensitive and stored lowercased in this codebase.
 */
export function normalizeOwnerAddress(
  chain: ChainEnum | string | undefined,
  addr: string | undefined,
): string | undefined {
  if (!addr) {
    return addr;
  }

  if (chain === ChainEnum.SOLANA) {
    return addr;
  }

  return addr.toLowerCase();
}
