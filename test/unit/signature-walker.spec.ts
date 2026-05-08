import {
  type ConfirmedSignatureInfo,
  type Connection,
  PublicKey,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { collectSignaturesSinceSlot } from "../../src/modules/sns/lib/signature-walker.ts";

const PROGRAM = new PublicKey("11111111111111111111111111111111");
const OPTIONS = { pageLimit: 1000, maxPagesPerTick: 5 };

function sig(
  signature: string,
  slot: number,
  err: unknown = null,
): ConfirmedSignatureInfo {
  return { signature, slot, err: err as never, memo: null };
}

function makeConn(pages: ConfirmedSignatureInfo[][]): {
  conn: Connection;
  spy: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const spy = vi.fn(async () => {
    return pages[i++] ?? [];
  });
  const conn = { getSignaturesForAddress: spy } as unknown as Connection;

  return { conn, spy };
}

describe("collectSignaturesSinceSlot", () => {
  it("cold start: takes one page only and returns all successful sigs", async () => {
    const { conn, spy } = makeConn([
      [sig("a", 100), sig("b", 99), sig("c", 98)],
      [sig("d", 97), sig("e", 96)], // should not be requested
    ]);
    const out = await collectSignaturesSinceSlot(conn, PROGRAM, 0, undefined, OPTIONS);

    expect(spy).toHaveBeenCalledOnce();
    expect(out.map((s) => s.signature)).toEqual(["a", "b", "c"]);
  });

  it("warm cursor: pages until oldest in page < lastSlot, filtering on >=", async () => {
    const { conn, spy } = makeConn([
      [sig("a", 110), sig("b", 105), sig("c", 100)],
      [sig("d", 95), sig("e", 90)],
    ]);
    const out = await collectSignaturesSinceSlot(conn, PROGRAM, 100, undefined, OPTIONS);

    // Page 1: oldest is slot 100 (>= cursor) so we page again.
    // Page 2: oldest is slot 90 (< cursor), we stop. Only sigs >= 100 collected.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.map((s) => s.signature)).toEqual(["a", "b", "c"]);
  });

  it("drops failed transactions", async () => {
    const { conn } = makeConn([
      [sig("a", 100, "InstructionError"), sig("b", 99)],
    ]);
    const out = await collectSignaturesSinceSlot(conn, PROGRAM, 0, undefined, OPTIONS);

    expect(out.map((s) => s.signature)).toEqual(["b"]);
  });

  it("respects maxPagesPerTick to bound RPC cost", async () => {
    const { conn, spy } = makeConn([
      [sig("a", 100)],
      [sig("b", 99)],
      [sig("c", 98)],
      [sig("d", 97)],
      [sig("e", 96)],
      [sig("f", 95)], // should not be requested
    ]);
    await collectSignaturesSinceSlot(conn, PROGRAM, 1, undefined, {
      pageLimit: 1000,
      maxPagesPerTick: 3,
    });

    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("passes `until: seedSig` through on the first page", async () => {
    const { conn, spy } = makeConn([[]]);
    await collectSignaturesSinceSlot(conn, PROGRAM, 0, "SEED", OPTIONS);

    expect(spy.mock.calls[0][1]).toMatchObject({ until: "SEED" });
  });

  it("returns [] when no pages have data", async () => {
    const { conn } = makeConn([[]]);
    const out = await collectSignaturesSinceSlot(conn, PROGRAM, 0, undefined, OPTIONS);

    expect(out).toEqual([]);
  });
});
