/**
 * `resolveServedConnection` (src/lib/seed/resolve-connection.ts), the one resolve of every request that names a
 * connection, with a server catalog installed (src/lib/db/server-catalog.ts): an engine whose provider package was
 * refused at boot is answered `PROVIDER_UNAVAILABLE` naming the refusal code, for an inline record and a seed alike,
 * after the access decision and before any Vault reference is read; an admitted package's engine resolves with the
 * record the server catalog answers, and a bundled engine with its legacy record.
 */
// oxlint-disable no-await-in-loop -- each case resolves after the one before, so a failure names its case.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderUnavailableError } from "@/lib/db/errors";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { forgetServerCatalog, installServerCatalog, legacyConnection, serverEngine } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { resetCache } from "@/lib/seed";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import * as vaultClient from "@/lib/seed/vault-client";
import type { DatabaseConnection } from "@/lib/types";
import { admittedFor, admittedManifest } from "../../helpers/package-catalog";

function vaultReference(): string {
  return "${vault:secret/data/x#y}";
}
const ADMIN = { role: "admin", username: "test" } as const;
const originalSeedPath = process.env.SEED_CONFIG_PATH;
let scratch: string;
let readVaultSecret: ReturnType<typeof spyOn>;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "libredb-resolve-package-"));
  const seedFile = path.join(scratch, "seed-connections.json");
  writeFileSync(
    seedFile,
    JSON.stringify({
      version: "1",
      connections: [
        { id: "gone", name: "Gone", type: "acmegone", host: "gone.example", password: vaultReference(), roles: ["*"] },
        { id: "served", name: "Served", type: "acmeserved", host: "served.example", roles: ["*"] },
      ],
    }),
  );
  process.env.SEED_CONFIG_PATH = seedFile;
  resetCache();
  readVaultSecret = spyOn(vaultClient, "readVaultSecret").mockResolvedValue("vault-resolved-secret");
  installServerCatalog(
    composeServerCatalog(
      [admittedFor("acme-served", admittedManifest("acmeserved"))],
      [{ name: "acme-gone", version: "1.0.0", engines: ["acmegone"], code: "PROVIDER_DIGEST_MISMATCH" }],
      STUDIO_GRANT_REGISTER,
    ),
  );
});

afterEach(() => {
  forgetServerCatalog();
  readVaultSecret.mockRestore();
  process.env.SEED_CONFIG_PATH = originalSeedPath;
  resetCache();
  rmSync(scratch, { recursive: true, force: true });
});

/** An inline connection of type `type`. */
function inline(type: string): DatabaseConnection {
  return {
    id: "user-conn",
    name: "Mine",
    type,
    host: "db.example",
    createdAt: new Date(),
  } as unknown as DatabaseConnection;
}

describe("a package engine on a connection route", () => {
  test("an inline connection or a seed of a refused package's engine is refused as PROVIDER_UNAVAILABLE naming the code", async () => {
    for (const body of [{ connection: inline("acmegone") }, { connectionId: "seed:gone" }]) {
      const refusal = await resolveServedConnection(body, ADMIN).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ProviderUnavailableError);
      expect((refusal as ProviderUnavailableError).codes).toEqual(["PROVIDER_DIGEST_MISMATCH"]);
      expect((refusal as Error).message).toContain("(PROVIDER_DIGEST_MISMATCH)");
    }
    expect(readVaultSecret).not.toHaveBeenCalled();
  });

  test("an admitted engine's connection, inline or seed, resolves with its record through the served resolve every request that names a connection reads, and a bundled engine's with its legacy record", async () => {
    const resolved = await resolveServedConnection({ connection: inline("acmeserved") }, ADMIN);
    expect(resolved.connection).toMatchObject({ type: "acmeserved", host: "db.example", managed: false });
    expect(resolved.engine.source.name).toBe("acme-served");

    // The seed schema is keyed by Studio's bundled engines, so a seed of a package's engine keeps only the fields every
    // seed has; it resolves as the package's engine all the same.
    const seed = await resolveServedConnection({ connectionId: "seed:served" }, ADMIN);
    expect([seed.connection.id, seed.connection.type, seed.engine.source.name]).toEqual([
      "seed:served",
      "acmeserved",
      "acme-served",
    ]);

    const bundled = await resolveServedConnection({ connection: inline("postgres") }, ADMIN);
    expect([bundled.connection.type, bundled.engine.source.name]).toEqual(["postgres", "@libredb/studio"]);
  });

  test("resolveServedConnection answers a package engine's connection with the record the server catalog answers, by reference", async () => {
    const served = serverEngine("acmeserved");
    if (served.kind !== "served") throw new Error(`acmeserved is ${served.kind}`);
    const inlineAnswer = await resolveServedConnection({ connection: inline("acmeserved") }, ADMIN);
    expect(inlineAnswer.connection).toMatchObject({ type: "acmeserved", host: "db.example", managed: false });
    expect(inlineAnswer.engine).toBe(served.engine);
    const seedAnswer = await resolveServedConnection({ connectionId: "seed:served" }, ADMIN);
    expect([seedAnswer.connection.id, seedAnswer.connection.type]).toEqual(["seed:served", "acmeserved"]);
    expect(seedAnswer.engine).toBe(served.engine);

    const legacy = serverEngine("postgres");
    if (legacy.kind !== "served") throw new Error(`postgres is ${legacy.kind}`);
    const bundled = await resolveServedConnection({ connection: inline("postgres") }, ADMIN);
    expect(bundled.engine).toBe(legacy.engine);
    expect(bundled.engine.offers.legacyProvider).toBe(true);
  });

  test("every shipped engine's inline connection resolves through the served resolve to itself with its engine's legacy record, as a legacy provider takes it", async () => {
    for (const id of SHIPPED_DATABASE_TYPES) {
      const legacy = serverEngine(id);
      if (legacy.kind !== "served") throw new Error(`${id} is ${legacy.kind}`);
      const connection = inline(id);
      const resolved = await resolveServedConnection({ connection }, ADMIN);
      expect(resolved.connection).toEqual({ ...connection, managed: false });
      expect(resolved.engine).toBe(legacy.engine);
      expect(resolved.engine.offers.legacyProvider).toBe(true);
      expect(resolved.connection).toBe(legacyConnection(resolved.engine, resolved.connection));
    }
  });

  test("the served resolve is the one resolve the module exports", async () => {
    expect(Object.keys(await import("@/lib/seed/resolve-connection")).sort()).toEqual([
      "SeedConnectionError",
      "resolveServedConnection",
    ]);
  });
});
