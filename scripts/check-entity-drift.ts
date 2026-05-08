/**
 * Entity-drift check.
 *
 * Diffs vendored entity files in this repo against the corresponding
 * files in the upstream `web3compassapi` repository. Fails (exit 1) on
 * drift. Run locally via `yarn check:entities`.
 *
 * The location of the upstream checkout is configured by env var
 * `WEB3COMPASSAPI_PATH`, defaulting to `../web3compassapi`.
 *
 * The drift policy is **exact byte match**. Whitespace, ordering, and
 * comment text all matter. If upstream changes something cosmetic,
 * mirror it here verbatim.
 *
 * NOTE: enums (`chain.enum.ts`, `migration-type.enum.ts`) are deliberately
 * EXCLUDED from drift check — this repo intentionally lags upstream by
 * commenting out new SNS_* / SOLANA values until the schema migration
 * has shipped. We re-enable them as part of the sync, at which point
 * the values match upstream.
 */
import * as fs from "fs";
import * as path from "path";

const upstreamRoot = path.resolve(
  process.env.WEB3COMPASSAPI_PATH ??
    path.join(__dirname, "../../web3compassapi"),
);
const localRoot = path.resolve(__dirname, "..");

interface IPairing {
  local: string;
  upstream: string;
}

const pairs: IPairing[] = [
  {
    local: "src/modules/dns/dns.entity.ts",
    upstream: "src/modules/dns/dns.entity.ts",
  },
  {
    local: "src/modules/dns/dns-migration.entity.ts",
    upstream: "src/modules/dns/dns-migration.entity.ts",
  },
  {
    local: "src/modules/dns/cid-processing/cid-processing.entity.ts",
    upstream: "src/modules/dns/cid-processing/cid-processing.entity.ts",
  },
  {
    local: "src/modules/dns/url.entity.ts",
    upstream: "src/modules/dns/url.entity.ts",
  },
  {
    local: "src/modules/dns/dns-settings.entity.ts",
    upstream: "src/modules/dns/dns-settings.entity.ts",
  },
  {
    local: "src/modules/dns/ens-resolver.entity.ts",
    upstream: "src/modules/dns/ens-resolver.entity.ts",
  },
  {
    local: "src/modules/pointer/content-pointer.entity.ts",
    upstream: "src/modules/pointer/content-pointer.entity.ts",
  },
  {
    local: "src/modules/common/entities/abstract.entity.ts",
    upstream: "src/modules/common/entities/abstract.entity.ts",
  },
];

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  if (!fs.existsSync(upstreamRoot)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[drift-check] Upstream not found at ${upstreamRoot}. Set WEB3COMPASSAPI_PATH or skip in CI.`,
    );
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
  }

  const drifts: string[] = [];

  for (const { local, upstream } of pairs) {
    const localPath = path.join(localRoot, local);
    const upstreamPath = path.join(upstreamRoot, upstream);

    const localContent = read(localPath);
    const upstreamContent = read(upstreamPath);

    if (localContent === null) {
      drifts.push(`MISSING (local): ${local}`);
      continue;
    }
    if (upstreamContent === null) {
      drifts.push(`MISSING (upstream): ${upstream}`);
      continue;
    }

    if (localContent !== upstreamContent) {
      drifts.push(`DRIFT: ${local}`);
    }
  }

  if (drifts.length > 0) {
    // eslint-disable-next-line no-console
    console.error("Entity drift detected:\n  " + drifts.join("\n  "));
    // eslint-disable-next-line no-console
    console.error(
      "\nRun the /sync-entities Claude skill, or copy the upstream files manually,\n" +
        "then re-run `yarn check:entities`.",
    );
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("[drift-check] OK — all entity files match upstream.");
}

main();
