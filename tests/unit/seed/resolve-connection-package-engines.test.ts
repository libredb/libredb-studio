/**
 * `resolveConnection` (src/lib/seed/resolve-connection.ts) with a server catalog installed
 * (src/lib/db/server-catalog.ts): an engine whose provider package was refused at boot is answered
 * `PROVIDER_UNAVAILABLE` naming the refusal code, for an inline record and a seed alike, after the access decision and
 * before any Vault reference is read, whichever engines the route serves; an admitted package's engine is refused by
 * name on a route that serves bundled engines alone, and resolved, by the same resolve with the same guards, on a route
 * that serves package engines too, which only Test Connection is in this Studio.
 */
// oxlint-disable no-await-in-loop -- each case resolves after the one before, so a failure names its case.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PackageEngineUnsupportedError, ProviderUnavailableError } from "@/lib/db/errors";
import { forgetServerCatalog, installServerCatalog, serverEngine } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { resetCache } from "@/lib/seed";
import { type ConnectionBody, resolveConnection } from "@/lib/seed/resolve-connection";
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
      (body: ConnectionBody) => resolveConnection(body, ADMIN, undefined, "bundled-and-package"),
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

  test("an admitted engine's connection is refused on a route that does not serve package engines, by name, and accepted by the package-aware resolve", async () => {
    for (const body of [{ connection: inline("acmeserved") }, { connectionId: "seed:served" }]) {
      const refusal = await resolveConnection(body, ADMIN).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PackageEngineUnsupportedError);
      expect((refusal as Error).message).toBe(
        "This request is served for an engine of a provider package only by Test Connection in this LibreDB Studio, and this is another request.",
      );
    }

    const resolved = await resolveConnection(
      { connection: inline("acmeserved") },
      ADMIN,
      undefined,
      "bundled-and-package",
    );
    expect(resolved).toMatchObject({ type: "acmeserved", host: "db.example", managed: false });
    const engine = serverEngine(resolved.type);
    if (engine.kind !== "package") throw new Error(`resolved ${engine.kind}`);
    expect(engine.engine.package.name).toBe("acme-served");

    // The seed schema is keyed by Studio's bundled engines, so a seed of a package's engine keeps only the fields every
    // seed has; it resolves as the package's engine all the same.
    const seed = await resolveConnection({ connectionId: "seed:served" }, ADMIN, undefined, "bundled-and-package");
    expect([seed.id, seed.type, serverEngine(seed.type).kind]).toEqual(["seed:served", "acmeserved", "package"]);

    const bundled = await resolveConnection(
      { connection: inline("postgres") },
      ADMIN,
      undefined,
      "bundled-and-package",
    );
    expect([bundled.type, serverEngine(bundled.type).kind]).toEqual(["postgres", "bundled"]);
  });
});
