/**
 * Live smoke test for SnsService against real Solana mainnet RPC.
 *
 * Skipped when no RPC credentials are present in the env. To run:
 *   SOLANA_RPC_PROVIDER=helius SOLANA_RPC_API_KEY=<key> yarn test
 *
 * The assertions are intentionally shape-only — we don't pin specific
 * content for `bonfida.sol` because on-chain state can change. We just
 * verify that the resolver runs without throwing and returns the
 * documented shape, and that owner / reverse-lookup return non-empty
 * base58 strings.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getDomainKeySync } from "@bonfida/spl-name-service";
import { describe, expect, it, beforeAll } from "vitest";

import { SnsService } from "../../src/modules/shared/services/sns.service";
import { SolanaService } from "../../src/modules/shared/services/solana.service";

const TEST_DOMAIN = "bonfida";

function resolveRpcUrl(): string | undefined {
  const explicit = process.env.SOLANA_RPC_URL;

  if (explicit) {
    return explicit;
  }

  const apiKey = process.env.SOLANA_RPC_API_KEY;

  if (!apiKey) {
    return undefined;
  }

  const provider = (process.env.SOLANA_RPC_PROVIDER ?? "helius").toLowerCase();
  const network = (process.env.SOLANA_RPC_NETWORK ?? "mainnet").toLowerCase();

  if (provider === "alchemy") {
    return network === "devnet"
      ? `https://solana-devnet.g.alchemy.com/v2/${apiKey}`
      : `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  return network === "devnet"
    ? `https://devnet.helius-rpc.com/?api-key=${apiKey}`
    : `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

const rpcUrl = resolveRpcUrl();
const describeIfRpc = rpcUrl ? describe : describe.skip;

/**
 * Minimal stand-in for ApiConfigService — lets us construct SolanaService
 * without booting the full Nest module.
 */
class StubApiConfig {
  get solanaConfig() {
    return { provider: "test", network: "mainnet", rpcUrl: rpcUrl as string };
  }
}

const stubLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
} as unknown as ConstructorParameters<typeof SnsService>[0];

describeIfRpc("SnsService (live RPC)", () => {
  let snsService: SnsService;
  let connection: Connection;

  beforeAll(() => {
    const solana = new SolanaService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new StubApiConfig() as any,
    );
    connection = solana.connection;
    snsService = new SnsService(stubLogger, solana);
  });

  it("connection is reachable", async () => {
    const slot = await connection.getSlot();
    expect(slot).toBeGreaterThan(0);
  });

  it("getOwner returns a non-empty base58 string for a known domain", async () => {
    const owner = await snsService.getOwner(TEST_DOMAIN);

    expect(owner).toBeTypeOf("string");
    expect(owner!.length).toBeGreaterThanOrEqual(32);
    expect(owner!.length).toBeLessThanOrEqual(44);
    // Must NOT be lowercased — Solana base58 is case-sensitive.
    expect(owner).not.toBe(owner!.toLowerCase());
  }, 30_000);

  it("reverseLookup round-trips a known domain", async () => {
    const { pubkey } = getDomainKeySync(TEST_DOMAIN);
    const name = await snsService.reverseLookup(pubkey);

    expect(name).toBe(TEST_DOMAIN);
  }, 30_000);

  it("resolveContent returns the documented shape (cid+contentType+source, or empty)", async () => {
    const result = await snsService.resolveContent(TEST_DOMAIN);

    if (result.cid) {
      expect(result.contentType).toMatch(/^(ipfs-ns|arweave-ns)$/);
      expect(result.source).toMatch(/^(v2-ipfs|v1-ipfs|v2-arwv|v1-arwv)$/);

      if (result.source!.startsWith("v2-")) {
        expect(result.roaVerified).toBe(true);
      }
    } else {
      expect(result).toEqual({});
    }
  }, 60_000);

  it("reverseLookup accepts a base58 string", async () => {
    const { pubkey } = getDomainKeySync(TEST_DOMAIN);
    const name = await snsService.reverseLookup(pubkey.toBase58());

    expect(name).toBe(TEST_DOMAIN);
  }, 30_000);

  it("reverseLookup returns undefined for an arbitrary non-name pubkey", async () => {
    // System program pubkey — definitively not a name account.
    const sysProgram = new PublicKey("11111111111111111111111111111111");
    const name = await snsService.reverseLookup(sysProgram);

    expect(name).toBeUndefined();
  }, 30_000);
});
