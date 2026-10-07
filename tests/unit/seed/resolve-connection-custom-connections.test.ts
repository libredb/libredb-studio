import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import path from "path";
import type { DatabaseConnection } from "@/lib/types";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetCache } from "@/lib/seed";
import { logger } from "@/lib/logger";

/*
 * ALLOW_CUSTOM_CONNECTIONS off. The operator seeds every database the users need and forbids
 * anything else, so a connection the caller supplies is refused here, the one place an inline
 * record becomes a provider's input. A seed stays reachable whichever way it is named.
 */
describe("resolve-connection with custom connections switched off", () => {
  beforeEach(() => {
    resetCache();
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";
  });

  afterEach(() => {
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  });

  it("refuses a connection of the caller's own with 403 and the operator's sentence", async () => {
    const own: DatabaseConnection = {
      id: "user-conn",
      name: "Platform database",
      type: "postgres",
      host: "platform-postgres",
      password: "guessed",
      createdAt: new Date(),
    };

    const error = await resolveConnection({ connection: own }, { role: "admin", username: "test" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SeedConnectionError);
    expect((error as SeedConnectionError).statusCode).toBe(403);
    expect((error as SeedConnectionError).message).toBe("Custom connections are disabled on this server");
    expect((error as SeedConnectionError).code).toBe("CUSTOM_CONNECTIONS_DISABLED");
  });

  it("logs who was refused and never the address they asked for", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const own: DatabaseConnection = {
        id: "user-conn",
        name: "Platform database",
        type: "postgres",
        host: "platform-postgres",
        createdAt: new Date(),
      };

      await resolveConnection({ connection: own }, { role: "user", username: "ada" }).catch(() => undefined);

      expect(warn).toHaveBeenCalledWith("Custom connection refused", {
        route: "seed/resolve-connection",
        user: "ada",
        role: "user",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("platform-postgres");
    } finally {
      warn.mockRestore();
    }
  });

  it("still resolves a seed named by connectionId", async () => {
    const result = await resolveConnection({ connectionId: "seed:everyone" }, { role: "user", username: "test" });

    expect(result.host).toBe("shared-pg.internal");
    expect(result.password).toBe("shared-secret");
  });

  // An unmanaged seed is copied into the browser and sent back as an inline record whose id is
  // still `seed:<id>`. It is resolved from the seed file, so it keeps working, and the copy's own
  // fields are ignored exactly as they are with the switch on.
  it("resolves an unmanaged seed's editable copy from the seed file, ignoring the copy's fields", async () => {
    const copy: DatabaseConnection = {
      id: "seed:everyone",
      name: "My edited copy",
      type: "postgres",
      host: "somewhere-else.internal",
      password: "typed-by-the-user",
      managed: false,
      seedId: "everyone",
      createdAt: new Date(),
    };

    const result = await resolveConnection({ connection: copy }, { role: "user", username: "test" });

    expect(result.host).toBe("shared-pg.internal");
    expect(result.password).toBe("shared-secret");
  });

  it("decides a claimed seed by the role filter, not by the switch", async () => {
    const forged: DatabaseConnection = {
      id: "seed:admin-only",
      name: "Not really the admin's",
      type: "postgres",
      host: "attacker.example.com",
      createdAt: new Date(),
    };

    const error = await resolveConnection({ connection: forged }, { role: "user", username: "test" }).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as SeedConnectionError).statusCode).toBe(403);
    expect((error as SeedConnectionError).message).toBe(
      'Access denied: connection "admin-only" not available for role "user"',
    );
    expect((error as SeedConnectionError).code).toBeUndefined();
  });
});
