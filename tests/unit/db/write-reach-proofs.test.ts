import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { WriteProof } from "@/lib/db/types";
import { WRITE_PATHS } from "@/lib/db/write-reach";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * Every gate and proof a provider's `writeReach` names is a real export, so renaming or deleting the symbol breaks
 * this test instead of leaving a declaration that names nothing.
 *
 * It proves the symbol exists and is a function or a frozen table, not that the symbol keeps the claim: each engine's
 * own tests hold that (the read-only end-to-end test of a guarded engine, and the route table, encoder, valve or
 * statement policy tests of an engine with no write path).
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

interface Named {
  readonly type: string;
  readonly path: string;
  readonly proof: WriteProof;
}

async function namedProofs(): Promise<Named[]> {
  const providers = await Promise.all(
    SHIPPED_DATABASE_TYPES.map(async (type) => ({
      type,
      provider: await createDatabaseProvider(CENSUS_CONNECTION[type]),
    })),
  );
  const named: Named[] = [];
  for (const { type, provider } of providers) {
    const declared = provider.getCapabilities().writeReach;
    if (declared === undefined) continue;
    for (const path of WRITE_PATHS) {
      const reach = declared[path];
      if (reach.reach === "gated") named.push({ type, path, proof: reach.gate });
      if (reach.reach === "absent" && reach.proof !== undefined) named.push({ type, path, proof: reach.proof });
    }
  }
  return named;
}

const NAMED = await namedProofs();

describe("every write-reach gate and proof names a real export", () => {
  test("the census found a proof or a gate on every non-open engine", () => {
    // Nineteen editor proofs, etcd's three gates, and Milvus's route-table proof and maintenance gate.
    expect(NAMED).toHaveLength(24);
  });

  test.each(NAMED.map((entry) => [`${entry.type} ${entry.path}`, entry] as const))(
    "%s: resolves to an exported function or frozen table",
    async (_label, { proof }) => {
      expect(proof.module).toMatch(/^src\/lib\/db\/.+\.ts$/);
      expect(existsSync(join(ROOT, proof.module))).toBe(true);
      const loaded = (await import(join(ROOT, proof.module))) as Record<string, unknown>;
      const exported = loaded[proof.symbol];
      const kept = typeof exported === "function" || (typeof exported === "object" && Object.isFrozen(exported));
      expect({ symbol: proof.symbol, kept }).toEqual({ symbol: proof.symbol, kept: true });
    },
  );

  test.each(NAMED.map((entry) => [`${entry.type} ${entry.path}`, entry] as const))(
    "%s: the proof lives in that provider's own directory or in a shared core, never another engine's",
    (_label, { type, proof }) => {
      const provider = /^src\/lib\/db\/providers\/[^/]+\/([^/]+)\//.exec(proof.module)?.[1];
      // influxdb and influxdb3 share one directory, which is the influxdb provider's.
      if (provider !== undefined) expect(type.startsWith(provider)).toBe(true);
    },
  );
});
