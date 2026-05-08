import type {
  ParsedInnerInstruction,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
  SOL_TLD_ROOT,
  SPL_NAME_SERVICE_PROGRAM_ID,
} from '../../../constants/sns.constants';

/**
 * Discriminator byte for SPL Name Service `Create`. The instruction layout
 * is `[disc:u8(0), hashed_name_len:u32, hashed_name, lamports:u64, space:u32]`.
 * Other discriminators on the same program (1=Update, 2=Transfer, 3=Delete,
 * 4=Realloc) must be ignored — only `Create` produces a brand-new domain.
 */
const SPL_NAME_SERVICE_CREATE_DISCRIMINATOR = 0;

/** Account index of the parent name in a Create instruction. */
const PARENT_ACCOUNT_INDEX = 5;
/** Account index of the new name account in a Create instruction. */
const NEW_NAME_ACCOUNT_INDEX = 2;
/** Account index of the new owner in a Create instruction. */
const NEW_OWNER_ACCOUNT_INDEX = 3;

export interface ISnsCreateMatch {
  /** The new `.sol` domain account pubkey (use with reverseLookup). */
  domainPubkey: PublicKey;
  /** Registry owner at registration time. Raw base58, never lowercased. */
  ownerPubkey: PublicKey;
}

type AnyParsedInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function isPartiallyDecoded(
  ix: AnyParsedInstruction,
): ix is PartiallyDecodedInstruction {
  return (
    typeof (ix as PartiallyDecodedInstruction).data === 'string' &&
    Array.isArray((ix as PartiallyDecodedInstruction).accounts)
  );
}

function decodeFirstByte(base58Data: string): number | undefined {
  if (!base58Data) {
    return undefined;
  }

  try {
    const bytes = bs58.decode(base58Data);

    return bytes.length > 0 ? bytes[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a single instruction as a top-level `.sol` `Create`. Returns
 * `undefined` for any instruction that isn't an SPL Name Service `Create`
 * with `parentName == SOL_TLD_ROOT`.
 *
 * Accepts both `PartiallyDecodedInstruction` (raw program calls) and
 * `ParsedInstruction` (instructions an RPC has decoded for known programs);
 * the latter never matches because SPL Name Service is not in the RPC's
 * parser registry.
 */
export function classifyCreateInstruction(
  ix: AnyParsedInstruction,
): ISnsCreateMatch | undefined {
  if (!isPartiallyDecoded(ix)) {
    return undefined;
  }

  if (!ix.programId.equals(SPL_NAME_SERVICE_PROGRAM_ID)) {
    return undefined;
  }

  if (ix.accounts.length <= PARENT_ACCOUNT_INDEX) {
    return undefined;
  }

  const discriminator = decodeFirstByte(ix.data);

  if (discriminator !== SPL_NAME_SERVICE_CREATE_DISCRIMINATOR) {
    return undefined;
  }

  const parent = ix.accounts[PARENT_ACCOUNT_INDEX];

  if (!parent || !parent.equals(SOL_TLD_ROOT)) {
    return undefined;
  }

  return {
    domainPubkey: ix.accounts[NEW_NAME_ACCOUNT_INDEX],
    ownerPubkey: ix.accounts[NEW_OWNER_ACCOUNT_INDEX],
  };
}

/**
 * Walk a parsed transaction's top-level + inner (CPI) instructions and
 * return every distinct `.sol` Create. Bonfida's registrar issues the
 * Create as a CPI, so inner-instruction coverage is required, not optional.
 */
export function extractSnsCreateMatches(
  topLevel: AnyParsedInstruction[],
  inner: ParsedInnerInstruction[] | null | undefined,
): ISnsCreateMatch[] {
  const matches: ISnsCreateMatch[] = [];
  const seen = new Set<string>();

  const consider = (ix: AnyParsedInstruction): void => {
    const match = classifyCreateInstruction(ix);

    if (!match) {
      return;
    }

    const key = match.domainPubkey.toBase58();

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    matches.push(match);
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
