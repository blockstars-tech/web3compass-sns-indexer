import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { SNS_RECORDS_V2_PROGRAM_ID } from "../../src/constants/sns.constants";
import {
  extractDomainFromV2Instruction,
  extractV2RecordDomains,
} from "../../src/modules/sns/parsers/sns-record-instruction";

const ZERO = new PublicKey("11111111111111111111111111111111");
const DOMAIN_A = new PublicKey(
  "5DTVN1mUNNXQyCnbidEdxUFD7nHMK6N9HFRSWnRCHnLm",
);
const DOMAIN_B = new PublicKey(
  "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNi",
);
const OTHER_PROGRAM = new PublicKey(
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
);

function makeV2Ix(opts: {
  programId?: PublicKey;
  domain?: PublicKey;
  /** Trim the accounts list to test bounds checking. */
  truncated?: boolean;
}) {
  const accounts = [
    ZERO, // 0 systemProgram
    ZERO, // 1 splNameService
    ZERO, // 2 feePayer
    ZERO, // 3 record
    opts.domain ?? DOMAIN_A, // 4 domain
    ZERO, // 5 domainOwner / centralState
    ZERO, // 6 centralState / verifier
  ];

  return {
    programId: opts.programId ?? SNS_RECORDS_V2_PROGRAM_ID,
    accounts: opts.truncated ? accounts.slice(0, 3) : accounts,
    data: "1", // any base58 — discriminator isn't read
  };
}

describe("extractDomainFromV2Instruction", () => {
  it("returns the domain pubkey for a V2 instruction", () => {
    const ix = makeV2Ix({});
    const domain = extractDomainFromV2Instruction(ix as never);

    expect(domain?.equals(DOMAIN_A)).toBe(true);
  });

  it("returns undefined for a different program", () => {
    const ix = makeV2Ix({ programId: OTHER_PROGRAM });
    const domain = extractDomainFromV2Instruction(ix as never);

    expect(domain).toBeUndefined();
  });

  it("returns undefined for a truncated key list", () => {
    const ix = makeV2Ix({ truncated: true });
    const domain = extractDomainFromV2Instruction(ix as never);

    expect(domain).toBeUndefined();
  });

  it("ignores ParsedInstruction shapes (rpc-decoded for known programs)", () => {
    const parsed = {
      program: "spl-name-service",
      programId: SNS_RECORDS_V2_PROGRAM_ID,
      parsed: { type: "deleteRecord" },
    };
    const domain = extractDomainFromV2Instruction(parsed as never);

    expect(domain).toBeUndefined();
  });
});

describe("extractV2RecordDomains", () => {
  it("dedupes the same domain across top-level + inner", () => {
    const ix = makeV2Ix({}) as never;
    const inner = [{ index: 0, instructions: [ix] }] as never;
    const domains = extractV2RecordDomains([ix], inner);

    expect(domains).toHaveLength(1);
    expect(domains[0].equals(DOMAIN_A)).toBe(true);
  });

  it("returns multiple distinct domains", () => {
    const a = makeV2Ix({}) as never;
    const b = makeV2Ix({ domain: DOMAIN_B }) as never;
    const domains = extractV2RecordDomains([a, b], null);

    expect(domains.map((d) => d.toBase58()).sort()).toEqual(
      [DOMAIN_A.toBase58(), DOMAIN_B.toBase58()].sort(),
    );
  });

  it("ignores instructions from unrelated programs", () => {
    const ix = makeV2Ix({ programId: OTHER_PROGRAM }) as never;
    const domains = extractV2RecordDomains([ix], null);

    expect(domains).toEqual([]);
  });
});
