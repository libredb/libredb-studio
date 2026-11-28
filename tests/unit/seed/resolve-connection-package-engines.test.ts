/**
 * `resolveConnection` (src/lib/seed/resolve-connection.ts) with a server catalog installed
 * (src/lib/db/server-catalog.ts): an engine whose provider package was refused at boot is answered
 * `PROVIDER_UNAVAILABLE` naming the refusal code, for an inline record and a seed alike, after the access decision and
 * before any Vault reference is read, whichever engines the route serves; an admitted package's engine is refused by
 * name by `resolveConnection`, which takes no source parameter, and resolved with its record by
 * `resolveServedConnection`, the same resolve with the same guards, which only Test Connection, the query route, the
 * cancel and disconnect routes, every object route but the source read, the monitoring, health and pool statistics
 * routes, the maintenance and preview routes and fleet health call in this Studio.
 */
// oxlint-disable no-await-in-loop -- each case resolves after the one before, so a failure names its case.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PackageEngineUnsupportedError, ProviderUnavailableError } from "@/lib/db/errors";
import { forgetServerCatalog, installServerCatalog, serverEngine } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { resetCache } from "@/lib/seed";
import { type ConnectionBody, resolveConnection, resolveServedConnection } from "@/lib/seed/resolve-connection";
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
    const routes = [
      (body: ConnectionBody) => resolveConnection(body, ADMIN),
      (body: ConnectionBody) => resolveServedConnection(body, ADMIN),
    ];
    for (const resolve of routes) {
      for (const body of [{ connection: inline("acmegone") }, { connectionId: "seed:gone" }]) {
        const refusal = await resolve(body).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(ProviderUnavailableError);
        expect((refusal as ProviderUnavailableError).codes).toEqual(["PROVIDER_DIGEST_MISMATCH"]);
        expect((refusal as Error).message).toContain("(PROVIDER_DIGEST_MISMATCH)");
      }
    }
    expect(readVaultSecret).not.toHaveBeenCalled();
  });

  test("an admitted engine's connection is refused by name on a route that resolves through resolveConnection, and accepted by the package-aware resolve the tree, edit, key scan, monitoring, health, pool statistics, cancel, disconnect, maintenance, preview and fleet health routes read", async () => {
    for (const body of [{ connection: inline("acmeserved") }, { connectionId: "seed:served" }]) {
      const refusal = await resolveConnection(body, ADMIN).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PackageEngineUnsupportedError);
      expect((refusal as Error).message).toBe(
        "This request is served for an engine of a provider package only by Test Connection, the query route and its cancel, a disconnect, the object tree's reads, the monitoring, health and maintenance requests and MCP in this LibreDB Studio, and this is another request.",
      );
    }

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

  test("a request that needs the legacy provider surface is refused for a package engine by reading the record's offer, 501 PACKAGE_ENGINE_UNSUPPORTED with today's sentence", async () => {
    // A legacy engine's record offers the legacy provider and a package's record offers none; the install refuses a
    // catalog whose offer disagrees with the id, so a route that serves bundled engines alone follows a valid record's
    // offer.
    forgetServerCatalog();
    installServerCatalog(
      composeServerCatalog([admittedFor("acme-served", admittedManifest("acmeserved"))], [], STUDIO_GRANT_REGISTER),
    );
    const refusal = await resolveConnection({ connection: inline("acmeserved") }, ADMIN).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PackageEngineUnsupportedError);
    expect([
      (refusal as PackageEngineUnsupportedError).code,
      (refusal as PackageEngineUnsupportedError).typeId,
    ]).toEqual(["PACKAGE_ENGINE_UNSUPPORTED", "acmeserved"]);
    expect((refusal as Error).message).toBe(
      "This request is served for an engine of a provider package only by Test Connection, the query route and its cancel, a disconnect, the object tree's reads, the monitoring, health and maintenance requests and MCP in this LibreDB Studio, and this is another request.",
    );
    const resolved = await resolveConnection({ connection: inline("postgres") }, ADMIN);
    expect(resolved).toMatchObject({ type: "postgres", host: "db.example", managed: false });
  });
  test("resolveServedConnection answers a package engine's connection with its record, and resolveConnection takes no source parameter", async () => {
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

    const refusal = await resolveConnection(
      { connection: inline("acmeserved") },
      ADMIN,
      undefined,
      // @ts-expect-error resolveConnection takes no source parameter
      "bundled-and-package",
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PackageEngineUnsupportedError);
    expect((refusal as PackageEngineUnsupportedError).code).toBe("PACKAGE_ENGINE_UNSUPPORTED");
  });
});
