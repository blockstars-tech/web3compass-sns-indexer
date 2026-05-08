/**
 * Solana Name Service program IDs and well-known constants.
 *
 * Sourced from:
 *   - https://github.com/SolanaNameService/sns-sdk
 *   - https://sns.guide/
 *   - https://github.com/Bonfida/sns-records
 *
 * These are mainnet-beta. Devnet IDs are not used by this indexer in v1.
 */
import { PublicKey } from "@solana/web3.js";

/** SPL Name Service — generic name registry program. Hosts every `.sol`. */
export const SPL_NAME_SERVICE_PROGRAM_ID = new PublicKey(
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
);

/** SNS Records V2 program — the new ROA-verified record format (SNS-IP-3). */
export const SNS_RECORDS_V2_PROGRAM_ID = new PublicKey(
  "HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ",
);

/** Bonfida Name Auctioning / Registrar — TLD authority that mints new `.sol`. */
export const BONFIDA_NAME_REGISTRAR_PROGRAM_ID = new PublicKey(
  "jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR",
);

/** `.sol` TLD root — the parent of every top-level `.sol` domain. */
export const SOL_TLD_ROOT = new PublicKey(
  "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx",
);

/**
 * Record names we recognize. The V1 derivation prefixes the name with
 * a 0x01 byte to distinguish records from real subdomains:
 *   `\x01IPFS.<domain>.sol`
 */
export const RecordName = {
  IPFS: "IPFS",
  ARWV: "ARWV",
} as const;
export type RecordName = (typeof RecordName)[keyof typeof RecordName];

/**
 * Content-type strings written to `dns.contentType`. These match the
 * codec strings used by the upstream content-pointer pipeline.
 */
export const ContentType = {
  IPFS: "ipfs-ns",
  ARWEAVE: "arweave-ns",
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];
