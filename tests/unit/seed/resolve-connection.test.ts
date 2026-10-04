import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import type { DatabaseConnection } from "@/lib/types";
import type { ManagedConnection } from "@/lib/seed/types";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetCache } from "@/lib/seed/config-loader";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import * as vaultClient from "@/lib/seed/vault-client";

describe("resolve-connection", () => {
  beforeEach(() => {
    resetCache();
  });

  it("returns connection object as-is when no connectionId", async () => {
    const conn: DatabaseConnection = {
      id: "user-conn",
      name: "User DB",
      type: "postgres",
      host: "localhost",
      createdAt: new Date(),
    };
    const result = await resolveConnection({ connection: conn }, { role: "user", username: "test" });
    expect(result.id).toBe("user-conn");
  });

  /*
   * The `seed:` namespace belongs to the operator's config, and an inline `connection` used to
   * be handed back verbatim, id included (GHSA-3wh2-8x78-jfw4 root cause 2). So a `user` account
   * could post a connection object CLAIMING `seed:admin-only` and skip the role filter that the
   * `connectionId` path applies two tests above. The provider cache then keyed on that claimed id
   * and handed back the admin's live pool; that half is closed in `src/lib/db/provider-cache-key.ts`,
   * and this is the other half - the claim itself is refused, so the namespace stays the
   * operator's and an audit line saying `seed:admin-only` means it really was.
   */
  it("refuses an inline connection that claims a seed id the role may not reach", async () => {
    const forged: DatabaseConnection = {
      id: "seed:admin-only",
      name: "Not really the admin's",
      type: "postgres",
      host: "attacker.example.com",
      password: "guess",
      createdAt: new Date(),
    };

    await expect(resolveConnection({ connection: forged }, { role: "user", username: "test" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("resolves an inline connection that claims a seed id the role may reach", async () => {
    const claimed: DatabaseConnection = {
      id: "seed:everyone",
      name: "Claimed",
      type: "postgres",
      host: "attacker.example.com",
      password: "guess",
      createdAt: new Date(),
    };

    // Resolved from the seed config rather than from what was posted: the caller may reach this
    // one, but the operator's record is what it means, not the caller's copy of it.
    const result = await resolveConnection({ connection: claimed }, { role: "user", username: "test" });
    expect(result.host).not.toBe("attacker.example.com");
    expect(result.password).toBe("shared-secret");
  });

  it("resolves seed connection by connectionId", async () => {
    const result = await resolveConnection({ connectionId: "seed:everyone" }, { role: "user", username: "test" });
    expect(result.id).toBe("seed:everyone");
    expect(result.password).toBe("shared-secret");
  });

  it("throws 403 when role does not have access", async () => {
    try {
      await resolveConnection({ connectionId: "seed:admin-only" }, { role: "user", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
    }
  });

  it("throws 404 when seed connection does not exist", async () => {
    try {
      await resolveConnection({ connectionId: "seed:nonexistent" }, { role: "admin", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(404);
    }
  });

  it("admin can access admin-only connections", async () => {
    const result = await resolveConnection({ connectionId: "seed:admin-only" }, { role: "admin", username: "test" });
    expect(result.password).toBe("admin-secret");
  });

  // What a `seed:` route answers when the seed file itself is broken is this error's message, and
  // any signed-in caller can ask: the role filter runs only after the file parses.
  it("does not hand a caller the seed file's text when the file fails to parse", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "malformed-secret-config.yaml");
    resetCache();

    try {
      const error = (await resolveConnection(
        { connectionId: "seed:broken-secret" },
        { role: "user", username: "test" },
      ).catch((thrown: unknown) => thrown)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Failed to parse seed config");
      expect(error.message).not.toContain("CanaryPlaintextPassword");
    } finally {
      process.env.SEED_CONFIG_PATH = origPath;
      resetCache();
    }
  });

  it("throws 400 when neither connection nor connectionId", async () => {
    try {
      await resolveConnection({}, { role: "admin", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
    }
  });
});

/*
  The literal marker on the query path (CapRover auto-connect spec 9.5). A discovered value is the text another
  app on the platform network set, so a `${vault:...}` in it must reach the provider as that text: resolving it
  would send one of Studio's own Vault secrets to that app as a password. readVaultSecret is replaced by a spy
  so a call to it is counted, not made.
*/
describe("resolve-connection with discovered connections", () => {
  const VAULT_REFERENCE = "${vault:secret/data/x#y}";
  const ADMIN = { role: "admin", username: "test" };
  const originalSeedPath = process.env.SEED_CONFIG_PATH;
  let discovery: DiscoveryExportFixture;
  let scratch: string;
  let readVaultSecret: ReturnType<typeof spyOn>;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "libredb-resolve-literal-"));
    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "caprover-x",
            name: "File seed with a discovery-like id",
            type: "postgres",
            host: "file-pg.internal",
            password: VAULT_REFERENCE,
            roles: ["admin"],
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    discovery = writeDiscoveryExport([postgresService("pg", VAULT_REFERENCE)]);
    process.env.SEED_DISCOVERY_PATH = discovery.path;
    resetCache();
    resetDiscoveryCache();
    readVaultSecret = spyOn(vaultClient, "readVaultSecret").mockResolvedValue("vault-resolved-secret");
  });

  afterEach(() => {
    readVaultSecret.mockRestore();
    process.env.SEED_CONFIG_PATH = originalSeedPath;
    delete process.env.SEED_DISCOVERY_PATH;
    resetCache();
    resetDiscoveryCache();
    discovery.remove();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("hands an admin a discovered ${vault:...} password as that literal text, without reading Vault", async () => {
    const result = await resolveConnection({ connectionId: "seed:caprover-pg" }, ADMIN);
    expect(result.password).toBe(VAULT_REFERENCE);
    // The marker is on what resolveConnection received from the list, after the role filter.
    expect((result as ManagedConnection).literal).toBe(true);
    expect(readVaultSecret).not.toHaveBeenCalled();
  });

  it("still resolves a seed-file connection whose id starts with caprover- through Vault", async () => {
    const result = await resolveConnection({ connectionId: "seed:caprover-x" }, ADMIN);
    expect(result.password).toBe("vault-resolved-secret");
    expect((result as ManagedConnection).literal).toBeUndefined();
    expect(readVaultSecret).toHaveBeenCalledTimes(1);
    expect(readVaultSecret).toHaveBeenCalledWith("secret/data/x", "y", undefined);
  });

  it("answers a standard user who names a discovered id with the 404 of an unknown id", async () => {
    const session = { role: "user", username: "test" };
    const discovered = await resolveConnection({ connectionId: "seed:caprover-pg" }, session).catch(
      (thrown: unknown) => thrown,
    );
    const unknown = await resolveConnection({ connectionId: "seed:caprover-none" }, session).catch(
      (thrown: unknown) => thrown,
    );

    expect(discovered).toBeInstanceOf(SeedConnectionError);
    expect(unknown).toBeInstanceOf(SeedConnectionError);
    expect((discovered as SeedConnectionError).statusCode).toBe(404);
    expect((unknown as SeedConnectionError).statusCode).toBe(404);
    expect((discovered as SeedConnectionError).message).toBe('Seed connection "caprover-pg" not found');
    expect((unknown as SeedConnectionError).message).toBe('Seed connection "caprover-none" not found');
    expect(readVaultSecret).not.toHaveBeenCalled();
  });
});
