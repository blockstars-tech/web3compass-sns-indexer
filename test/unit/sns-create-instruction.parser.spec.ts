import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  SOL_TLD_ROOT,
  SPL_NAME_SERVICE_PROGRAM_ID,
} from "../../src/constants/sns.constants";
import {
  classifyCreateInstruction,
  extractSnsCreateMatches,
} from "../../src/modules/sns/parsers/sns-create-instruction";

const ZERO_KEY = new PublicKey("11111111111111111111111111111111");
const NEW_DOMAIN = new PublicKey(
  "5DTVN1mUNNXQyCnbidEdxUFD7nHMK6N9HFRSWnRCHnLm",
);
const NEW_OWNER = new PublicKey(
  "9Wzy3sf5sTr6F1nLTdRnUFhc6QQuwbGSmCcKPjjeCvLU",
);
const REVERSE_LOOKUP_CLASS = new PublicKey(
  "33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z",
);

function encodeCreateData(discriminator: number): string {
  // Layout: [disc:u8] [hashed_name_len:u32 LE] [hashed_name: 32 bytes]
  // [lamports:u64] [space:u32]. The exact payload doesn't matter for
  // classification — only the discriminator byte is read.
  const buf = Buffer.concat([
    Buffer.from([discriminator]),
    Buffer.from([32, 0, 0, 0]),
    Buffer.alloc(32, 0xab),
    Buffer.alloc(8, 0),
    Buffer.alloc(4, 0),
  ]);

  return bs58.encode(buf);
}

function makeCreateIx(opts: {
  programId?: PublicKey;
  discriminator?: number;
  parent?: PublicKey;
  domain?: PublicKey;
  owner?: PublicKey;
}) {
  return {
    programId: opts.programId ?? SPL_NAME_SERVICE_PROGRAM_ID,
    accounts: [
      ZERO_KEY, // 0 system program
      ZERO_KEY, // 1 payer
      opts.domain ?? NEW_DOMAIN, // 2 new name account
      opts.owner ?? NEW_OWNER, // 3 new owner
      ZERO_KEY, // 4 name class
      opts.parent ?? SOL_TLD_ROOT, // 5 parent
      ZERO_KEY, // 6 parent owner
    ],
    data: encodeCreateData(opts.discriminator ?? 0),
  };
}

describe("classifyCreateInstruction", () => {
  it("matches a Create whose parent is the .sol TLD root", () => {
    const match = classifyCreateInstruction(makeCreateIx({}) as never);

    expect(match).toBeDefined();
    expect(match!.domainPubkey.equals(NEW_DOMAIN)).toBe(true);
    expect(match!.ownerPubkey.equals(NEW_OWNER)).toBe(true);
  });

  it("rejects non-zero discriminators (Update / Transfer / Delete)", () => {
    for (const d of [1, 2, 3, 4]) {
      const match = classifyCreateInstruction(
        makeCreateIx({ discriminator: d }) as never,
      );

      expect(match).toBeUndefined();
    }
  });

  it("rejects a Create whose parent is not the .sol root (e.g. a subdomain)", () => {
    const match = classifyCreateInstruction(
      makeCreateIx({ parent: REVERSE_LOOKUP_CLASS }) as never,
    );

    expect(match).toBeUndefined();
  });

  it("rejects an instruction from an unrelated program ID", () => {
    const match = classifyCreateInstruction(
      makeCreateIx({ programId: REVERSE_LOOKUP_CLASS }) as never,
    );

    expect(match).toBeUndefined();
  });

  it("rejects truncated instructions that lack the parent slot", () => {
    const ix = {
      programId: SPL_NAME_SERVICE_PROGRAM_ID,
      accounts: [ZERO_KEY, ZERO_KEY, NEW_DOMAIN],
      data: encodeCreateData(0),
    };
    const match = classifyCreateInstruction(ix as never);

    expect(match).toBeUndefined();
  });

  it("ignores ParsedInstruction (decoded by RPC for known programs)", () => {
    const parsed = {
      program: "system",
      programId: SPL_NAME_SERVICE_PROGRAM_ID,
      parsed: { type: "createAccount" },
    };
    const match = classifyCreateInstruction(parsed as never);

    expect(match).toBeUndefined();
  });
});

describe("extractSnsCreateMatches", () => {
  it("finds matches in inner CPIs (the Bonfida registrar path)", () => {
    const inner = [
      {
        index: 0,
        instructions: [makeCreateIx({}) as never],
      },
    ];
    const matches = extractSnsCreateMatches([], inner as never);

    expect(matches).toHaveLength(1);
    expect(matches[0].domainPubkey.equals(NEW_DOMAIN)).toBe(true);
  });

  it("dedupes by domain pubkey across top-level + inner", () => {
    const ix = makeCreateIx({}) as never;
    const inner = [{ index: 0, instructions: [ix] }];
    const matches = extractSnsCreateMatches([ix], inner as never);

    expect(matches).toHaveLength(1);
  });

  it("returns multiple matches when distinct domains are minted in one tx", () => {
    const second = new PublicKey(
      "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNi",
    );
    const matches = extractSnsCreateMatches(
      [
        makeCreateIx({}) as never,
        makeCreateIx({ domain: second }) as never,
      ],
      null,
    );

    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.domainPubkey.toBase58()).sort()).toEqual(
      [NEW_DOMAIN.toBase58(), second.toBase58()].sort(),
    );
  });

  it("returns an empty list when no matching instructions exist", () => {
    const matches = extractSnsCreateMatches(
      [makeCreateIx({ programId: REVERSE_LOOKUP_CLASS }) as never],
      null,
    );

    expect(matches).toEqual([]);
  });
});
