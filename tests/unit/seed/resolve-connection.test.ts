import { describe, it, expect, beforeEach } from "bun:test";
import path from "path";
import type { DatabaseConnection } from "@/lib/types";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetCache } from "@/lib/seed/config-loader";

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
