import type {
  ParsedInnerInstruction,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';

import { SNS_RECORDS_V2_PROGRAM_ID } from '../../../constants/sns.constants';

/**
 * Account index of the `domain` PDA in every SNS Records V2 instruction.
 *
 * Verified against `@bonfida/sns-records` v3 — the `getInstruction(...)`
 * signature is identical across all 8 instruction tags
 * (`allocateRecord`, `allocateAndPostRecord`, `editRecord`,
 * `validateSolanaSignature`, `validateEthereumSignature`, `deleteRecord`,
 * `writeRoa`, `unverifyRoa`). The key array always begins:
 *
 *   [0] systemProgram
 *   [1] splNameServiceProgram
 *   [2] feePayer
 *   [3] record
 *   [4] domain               ← this is the `.sol` account we flag
 *   [5] domainOwner | centralState (depends on tag)
 *   [6+] tag-specific
 */
const DOMAIN_ACCOUNT_INDEX = 4;

type AnyParsedInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function isPartiallyDecoded(
  ix: AnyParsedInstruction,
): ix is PartiallyDecodedInstruction {
  return (
    typeof (ix as PartiallyDecodedInstruction).data === 'string' &&
    Array.isArray((ix as PartiallyDecodedInstruction).accounts)
  );
}

/**
 * Return the domain pubkey if the instruction touches the SNS Records V2
 * program; otherwise undefined. Cheap structural check — no base58 decode
 * of the data field needed because all V2 tags have the same key layout.
 */
export function extractDomainFromV2Instruction(
  ix: AnyParsedInstruction,
): PublicKey | undefined {
  if (!isPartiallyDecoded(ix)) {
    return undefined;
  }

  if (!ix.programId.equals(SNS_RECORDS_V2_PROGRAM_ID)) {
    return undefined;
  }

  if (ix.accounts.length <= DOMAIN_ACCOUNT_INDEX) {
    return undefined;
  }

  return ix.accounts[DOMAIN_ACCOUNT_INDEX];
}

/**
 * Walk a parsed transaction's top-level + inner CPIs and return every
 * distinct `.sol` domain pubkey touched by an SNS Records V2 instruction.
 */
export function extractV2RecordDomains(
  topLevel: AnyParsedInstruction[],
  inner: ParsedInnerInstruction[] | null | undefined,
): PublicKey[] {
  const seen = new Set<string>();
  const matches: PublicKey[] = [];

  const consider = (ix: AnyParsedInstruction): void => {
    const domain = extractDomainFromV2Instruction(ix);

    if (!domain) {
      return;
    }

    const key = domain.toBase58();

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    matches.push(domain);
  };

  for (const ix of topLevel) {
    consider(ix);
  }

  for (const group of inner ?? []) {
    for (const ix of group.instructions) {
      consider(ix);
    }
  }

  return matches;
}
