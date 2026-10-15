import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import type { DatabaseConnection } from "@/lib/types";
import type { ManagedConnection } from "@/lib/seed/types";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";
import {
  admittedConnection,
  grantedSnapshot,
  READ_CREDENTIAL,
  WRITE_CREDENTIAL,
} from "../../helpers/governance/granted-snapshot";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

import * as seedIndex from "@/lib/seed";
import { getManagedConnections, resetCache } from "@/lib/seed";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import * as vaultClient from "@/lib/seed/vault-client";
import { logger } from "@/lib/logger";
import { resetLiteralModeNotices, resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { recordGovernanceFailure, recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";

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

  it("strips a client's managed claim from an inline connection", async () => {
    const conn = {
      id: "user-bq",
      name: "User BQ",
      type: "bigquery",
      database: "p",
      managed: true,
      location: "EU",
      createdAt: new Date(),
    } as DatabaseConnection;
    const result = await resolveConnection({ connection: conn }, { role: "user", username: "test" });
    expect(result.managed).toBe(false);
    expect(result.location).toBe("EU");
  });

  it("strips a client's managed claim from an inline Firestore connection, which would otherwise reach the server's identity", async () => {
    const conn = {
      id: "user-fs",
      name: "User FS",
      type: "firestore",
      database: "acme-orders",
      managed: true,
      createdAt: new Date(),
    } as DatabaseConnection;
    const result = await resolveConnection({ connection: conn }, { role: "user", username: "test" });
    expect(result.managed).toBe(false);
    expect(result.database).toBe("acme-orders");
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

  /*
   * An empty `connectionId` is falsy but not nullish, so `connectionId ?? claimedSeedId` once kept
   * it and dropped the claim: the inline record then came back verbatim, its `seed:` id included,
   * and the namespace check above never ran. A present id must be a non-empty string.
   */
  it.each([[""], [0], [false], [{}]])(
    "refuses a connectionId of %p next to an inline seed claim",
    async (connectionId) => {
      const forged: DatabaseConnection = {
        id: "seed:admin-only",
        name: "Not really the admin's",
        type: "postgres",
        host: "attacker.example.com",
        password: "guess",
        createdAt: new Date(),
      };

      await expect(
        resolveConnection(
          { connection: forged, connectionId: connectionId as unknown as string },
          { role: "user", username: "test" },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    },
  );

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

  // The marker is set in code only. A seed file that writes `literal: true` on its own connection is not the
  // discovery source, so that connection is listed without the field and its ${vault:...} is still resolved.
  it("ignores a literal key written in the seed file: no marker is listed and Vault is still read", async () => {
    const seedFile = path.join(scratch, "seed-with-literal-key.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "file-literal",
            name: "File seed that asks to be literal",
            type: "postgres",
            host: "file-pg.internal",
            password: VAULT_REFERENCE,
            roles: ["admin"],
            literal: true,
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    resetCache();

    const listed = (await getManagedConnections(["admin"])).find((c) => c.seedId === "file-literal");
    expect(listed?.host).toBe("file-pg.internal");
    expect(listed).not.toHaveProperty("literal");

    const result = await resolveConnection({ connectionId: "seed:file-literal" }, ADMIN);
    expect(result.password).toBe("vault-resolved-secret");
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

/*
  Review Focus A1.5. The operator loader resolves `${NAME}` inside its cache fill and records the literal mode that
  fill read, so SEED_LITERAL_VALUES flipped between two calls must still decide each call: no `${NAME}` resolved, no
  plaintext warning and no Vault read while it is on, and today's resolution once it is off, with no resetCache() in
  between and the cache warm for the whole test.
*/
describe("resolve-connection with SEED_LITERAL_VALUES toggled on a warm operator cache", () => {
  const ADMIN = { role: "admin", username: "test" };
  const ENV_REFERENCE = "${LITERAL_MODE_PROBE_PASSWORD}";
  const VAULT_REFERENCE = "${vault:secret/data/literal#password}";
  const PLAINTEXT_WARNING = "Seed connection has plaintext password, use ${ENV_VAR} syntax";
  const originalSeedPath = process.env.SEED_CONFIG_PATH;
  let scratch: string;
  let readVaultSecret: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "libredb-resolve-literal-mode-"));
    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "env-ref",
            name: "Env",
            type: "postgres",
            host: "env.internal",
            password: ENV_REFERENCE,
            roles: ["admin"],
          },
          {
            id: "vault-ref",
            name: "Vault",
            type: "postgres",
            host: "vault.internal",
            password: VAULT_REFERENCE,
            roles: ["admin"],
          },
          {
            id: "plain",
            name: "Plain",
            type: "postgres",
            host: "plain.internal",
            password: "plain-password",
            roles: ["admin"],
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    process.env.LITERAL_MODE_PROBE_PASSWORD = "resolved-from-env";
    process.env.SEED_CACHE_TTL_MS = "60000";
    resetCache();
    resetPlaintextWarnings();
    resetLiteralModeNotices();
    readVaultSecret = spyOn(vaultClient, "readVaultSecret").mockResolvedValue("vault-resolved-secret");
    warn = spyOn(logger, "warn");
  });

  afterEach(() => {
    readVaultSecret.mockRestore();
    warn.mockRestore();
    process.env.SEED_CONFIG_PATH = originalSeedPath;
    delete process.env.LITERAL_MODE_PROBE_PASSWORD;
    delete process.env.SEED_CACHE_TTL_MS;
    delete process.env.SEED_LITERAL_VALUES;
    resetCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  const plaintextWarnings = () => (warn.mock.calls as unknown[][]).filter((call) => call[0] === PLAINTEXT_WARNING);

  it("resolves nothing, warns of nothing and reads no Vault while the mode is on, and resolves again once it is off", async () => {
    process.env.SEED_LITERAL_VALUES = "true";
    const literal = await getManagedConnections(["admin"]);
    expect(literal.map((c) => [c.seedId, c.password, c.literal])).toEqual([
      ["env-ref", ENV_REFERENCE, true],
      ["vault-ref", VAULT_REFERENCE, true],
      ["plain", "plain-password", true],
    ]);
    expect((await resolveConnection({ connectionId: "seed:vault-ref" }, ADMIN)).password).toBe(VAULT_REFERENCE);
    expect(readVaultSecret).not.toHaveBeenCalled();
    expect(plaintextWarnings()).toEqual([]);

    process.env.SEED_LITERAL_VALUES = "false";
    const resolved = await getManagedConnections(["admin"]);
    expect(resolved.map((c) => [c.seedId, c.password, "literal" in c])).toEqual([
      ["env-ref", "resolved-from-env", false],
      ["vault-ref", VAULT_REFERENCE, false],
      ["plain", "plain-password", false],
    ]);
    expect((await resolveConnection({ connectionId: "seed:vault-ref" }, ADMIN)).password).toBe("vault-resolved-secret");
    expect(readVaultSecret).toHaveBeenCalledTimes(1);
    expect(plaintextWarnings()).toHaveLength(1);

    process.env.SEED_LITERAL_VALUES = "true";
    expect((await resolveConnection({ connectionId: "seed:env-ref" }, ADMIN)).password).toBe(ENV_REFERENCE);
    expect((await resolveConnection({ connectionId: "seed:vault-ref" }, ADMIN)).password).toBe(VAULT_REFERENCE);
    expect(readVaultSecret).toHaveBeenCalledTimes(1);
    expect(plaintextWarnings()).toHaveLength(1);
  });
});

/*
  Governance mode (docs/GOVERNANCE.md): a `seed:` id names a connection of the governance source, and it resolves only
  through a grant the session's identity provider subject holds in the snapshot, checked against expiry with Studio's
  own clock. A connection that does not exist and one granted to someone else answer the same 404, decided from the
  caller's own grants alone, so nothing tells a caller which ids exist. The snapshot is built directly
  (tests/helpers/governance/granted-snapshot.ts) and the clock is frozen, so each case states its grants and its time.
*/
describe("resolve-connection under governance", () => {
  const T = Date.parse("2026-10-15T08:00:00.000Z");
  const ORDERS = admittedConnection("orders", { write: true });
  const BILLING = admittedConnection("billing");
  const ALICE = { role: "user", username: "alice@example.com", idpSubject: "alice-subject" };
  const BOB = { role: "admin", username: "bob@example.com", idpSubject: "bob-subject" };
  const NOT_FOUND = {
    name: "SeedConnectionError",
    message: "Connection not found: it does not exist or is not granted to you",
    statusCode: 404,
    code: "CONNECTION_NOT_FOUND",
  };
  let unfiltered: ReturnType<typeof spyOn>;
  let readVaultSecret: ReturnType<typeof spyOn>;
  let log: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;

  /** The audit lines written to stdout so far, parsed. */
  const auditLines = () =>
    (log.mock.calls as unknown[][]).map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

  const failureOf = (attempt: Promise<unknown>) => attempt.catch((thrown: unknown) => thrown);

  beforeEach(() => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
    setSystemTime(new Date(T));
    resetCache();
    resetGovernanceState();
    clearRateLimitState();
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, BILLING],
        [
          { subject: ALICE.idpSubject, connection: ORDERS, level: "write", expiresAt: T + 60_000 },
          { subject: ALICE.idpSubject, connection: BILLING, level: "read" },
          { subject: BOB.idpSubject, connection: BILLING, level: "read" },
        ],
      ),
    );
    unfiltered = spyOn(seedIndex, "getSeedConnectionByIdUnfiltered");
    readVaultSecret = spyOn(vaultClient, "readVaultSecret").mockResolvedValue("vault-resolved-secret");
    log = spyOn(console, "log").mockImplementation(() => {});
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    unfiltered.mockRestore();
    readVaultSecret.mockRestore();
    log.mockRestore();
    warn.mockRestore();
    setSystemTime();
    resetGovernanceState();
    clearRateLimitState();
    delete process.env.GOVERNANCE_SOURCE;
  });

  it("governance: an unknown id and a non-granted id answer the same 404 CONNECTION_NOT_FOUND and getSeedConnectionByIdUnfiltered is never called", async () => {
    // Bob holds no grant on orders, which exists; no connection has the id no-such-connection.
    const notGranted = await failureOf(resolveConnection({ connectionId: "seed:orders" }, BOB));
    const unknown = await failureOf(resolveConnection({ connectionId: "seed:no-such-connection" }, BOB));
    // The same answer for an inline record that claims the id, which resolves as the id.
    const claimed = await failureOf(
      resolveConnection(
        { connection: { id: "seed:orders", name: "Copy", type: "postgres", createdAt: new Date(T) } },
        BOB,
      ),
    );

    for (const error of [notGranted, unknown, claimed]) {
      expect(error).toBeInstanceOf(SeedConnectionError);
      expect(error).toMatchObject(NOT_FOUND);
    }
    expect(unfiltered).not.toHaveBeenCalled();
  });

  it("governance: a read grant gets the read credential, a write grant the write credential, and credential read always the read credential", async () => {
    const credential = (connection: unknown) => {
      const { id, user, password, grantLevel } = connection as Record<string, unknown>;
      return { id, user, password, grantLevel };
    };

    expect(credential(await resolveConnection({ connectionId: "seed:billing" }, ALICE))).toEqual({
      id: "seed:billing",
      ...READ_CREDENTIAL,
      grantLevel: "read",
    });
    expect(credential(await resolveConnection({ connectionId: "seed:orders" }, ALICE))).toEqual({
      id: "seed:orders",
      ...WRITE_CREDENTIAL,
      grantLevel: "write",
    });
    expect(credential(await resolveConnection({ connectionId: "seed:orders" }, ALICE, { credential: "read" }))).toEqual(
      { id: "seed:orders", ...READ_CREDENTIAL, grantLevel: "read" },
    );
    expect(
      credential(await resolveConnection({ connectionId: "seed:orders" }, ALICE, { credential: "grant" })),
    ).toEqual({ id: "seed:orders", ...WRITE_CREDENTIAL, grantLevel: "write" });
    expect(unfiltered).not.toHaveBeenCalled();
  });

  it("governance: an expired grant answers 404 without a reload", async () => {
    expect((await resolveConnection({ connectionId: "seed:orders" }, ALICE)).user).toBe(WRITE_CREDENTIAL.user);

    // The same snapshot object, a minute later: expiry fires no notification, so the clock alone decides.
    setSystemTime(new Date(T + 60_000));

    expect(await failureOf(resolveConnection({ connectionId: "seed:orders" }, ALICE))).toMatchObject(NOT_FOUND);
    expect((await resolveConnection({ connectionId: "seed:billing" }, ALICE)).user).toBe(READ_CREDENTIAL.user);
  });

  it("governance: a miss is audited as permission_denied with reason connection_not_granted, metered on the anon bucket", async () => {
    // RATE_LIMIT_ANON_MAX is 5 by default: five lines, one more for the request that trips the bucket, then none.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each miss spends the bucket in turn.
      expect(await failureOf(resolveConnection({ connectionId: "seed:orders" }, BOB))).toMatchObject(NOT_FOUND);
    }

    const lines = auditLines();
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).toMatchObject({
        schema: "libredb.audit.v1",
        event: "permission_denied",
        action: "denied",
        outcome: "failure",
        actor: "bob@example.com",
        route: "governance/connection",
        reason: "connection_not_granted",
        connection: "orders",
      });
    }
    // The bucket is keyed on the account: another account's misses are audited from its own budget.
    expect(await failureOf(resolveConnection({ connectionId: "seed:crm" }, ALICE))).toMatchObject(NOT_FOUND);
    expect(auditLines()).toHaveLength(7);
    expect(auditLines()[6]).toMatchObject({ actor: "alice@example.com", connection: "crm" });
  });

  it("governance: a broken audit sink still answers the 404", async () => {
    log.mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await failureOf(resolveConnection({ connectionId: "seed:orders" }, BOB))).toMatchObject(NOT_FOUND);
      expect(error).toHaveBeenCalledWith("Failed to record permission_denied audit event", expect.any(Error), {
        route: "seed/resolve-connection",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("governance: a found connection is not audited", async () => {
    await resolveConnection({ connectionId: "seed:billing" }, BOB);
    expect(auditLines()).toEqual([]);
  });

  it("governance: a snapshot that cannot be served answers 503 GOVERNANCE_UNAVAILABLE for every seed id, audited as no miss", async () => {
    recordGovernanceFailure({
      at: T,
      kind: "misconfigured",
      code: "42501",
      detail: "bridge.grants_v1: denied",
      publicDetail: "bridge.grants_v1: 42501",
    });

    for (const connectionId of ["seed:billing", "seed:orders", "seed:no-such-connection"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a browser sends them.
      const error = await failureOf(resolveConnection({ connectionId }, BOB));
      expect(error).toBeInstanceOf(SeedConnectionError);
      expect(error).toMatchObject({
        message: "Connection access is unavailable while this server cannot read its governance source",
        statusCode: 503,
        code: "GOVERNANCE_UNAVAILABLE",
      });
    }
    expect(auditLines()).toEqual([]);
    expect(unfiltered).not.toHaveBeenCalled();
  });

  it("governance: an inline connection keeps the 403 CUSTOM_CONNECTIONS_DISABLED, also while the snapshot cannot be served", async () => {
    const own: DatabaseConnection = {
      id: "my-own",
      name: "Platform database",
      type: "postgres",
      host: "platform-postgres",
      createdAt: new Date(T),
    };
    const refusal = { statusCode: 403, code: "CUSTOM_CONNECTIONS_DISABLED" };

    expect(await failureOf(resolveConnection({ connection: own }, ALICE))).toMatchObject(refusal);
    resetGovernanceState();
    expect(await failureOf(resolveConnection({ connection: own }, ALICE))).toMatchObject(refusal);
  });

  it("governance: an inline record that claims a granted id resolves to the governed record, not the caller's copy", async () => {
    const copy: DatabaseConnection = {
      id: "seed:billing",
      name: "My copy",
      type: "postgres",
      host: "attacker.example.com",
      password: "typed-by-the-caller",
      createdAt: new Date(T),
    };

    const result = await resolveConnection({ connection: copy }, ALICE);

    expect(result.host).toBe("billing.db.example.internal");
    expect(result.password).toBe(READ_CREDENTIAL.password);
  });

  it("governance: a value the control plane set is handed over as written: a Vault reference in it is never read", async () => {
    const VAULT_REFERENCE = "${vault:secret/data/x#y}";
    const vaulted = admittedConnection("vaulted", { extra: { password: VAULT_REFERENCE } });
    recordGovernanceSnapshot(
      grantedSnapshot([vaulted], [{ subject: ALICE.idpSubject, connection: vaulted, level: "read" }], T),
    );

    expect((await resolveConnection({ connectionId: "seed:vaulted" }, ALICE)).password).toBe(VAULT_REFERENCE);
    expect(readVaultSecret).not.toHaveBeenCalled();
  });

  it("governance: a session without an identity provider subject resolves nothing", async () => {
    const error = await failureOf(
      resolveConnection({ connectionId: "seed:billing" }, { role: "admin", username: "admin" }),
    );
    expect(error).toMatchObject(NOT_FOUND);
  });
});
