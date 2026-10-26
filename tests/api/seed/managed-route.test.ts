import { describe, it, expect, beforeEach, afterEach, mock, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

// Mock auth — must be before route import
mock.module("@/lib/auth", () => ({
  getSession: mock(() => ({ role: "admin", username: "admin@test.com" })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin@test.com" },
  })),
  verifyJWT: mock(() => ({ role: "admin", username: "admin@test.com" })),
}));

import { GET } from "@/app/api/connections/managed/route";
import { resetCache } from "@/lib/seed";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import { getSession } from "@/lib/auth";
import { setSqliteSampleSeedState, SQLITE_SAMPLE_SEED_ID } from "@/lib/seed/sqlite-sample";
import { SEED_CONFIG_UNREADABLE_REASON } from "@/hooks/use-connection-payload";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import { admittedConnection, grantedSnapshot, WRITE_CREDENTIAL } from "../../helpers/governance/granted-snapshot";

describe("GET /api/connections/managed", () => {
  beforeEach(() => {
    resetCache();
    // Reset mock to default admin session
    (getSession as ReturnType<typeof mock>).mockImplementation(() => ({ role: "admin", username: "admin@test.com" }));
  });

  // One seed entry whose MCP opt-in is not a boolean fails the whole file, as any invalid field
  // does, and the failure names itself (#246).
  it("names the seed configuration when one connection's mcp is not a boolean", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    const dir = mkdtempSync(path.join(tmpdir(), "libredb-seed-mcp-"));
    const file = path.join(dir, "seed-connections.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: "1",
        connections: [
          { id: "shop", name: "Shop", type: "sqlite", database: path.join(dir, "shop.db"), roles: ["*"], mcp: "yes" },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = file;
    resetCache();
    try {
      const res = await GET();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "Failed to load managed connections",
        reason: SEED_CONFIG_UNREADABLE_REASON,
      });
    } finally {
      process.env.SEED_CONFIG_PATH = origPath;
      resetCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns managed connections for admin role", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections.length).toBeGreaterThan(0);
    expect(data.cacheHint).toBe(60000);
  });

  it("filters connections by role", async () => {
    const res = await GET();
    const data = await res.json();
    const ids = data.connections.map((c: { seedId: string }) => c.seedId);
    expect(ids).toContain("admin-only");
    expect(ids).toContain("everyone");
    expect(ids).toContain("admin-and-user");
  });

  it("strips password from managed:true connections", async () => {
    const res = await GET();
    const data = await res.json();
    const managed = data.connections.find((c: { managed: boolean }) => c.managed);
    if (managed) {
      expect(managed.password).toBeUndefined();
    }
  });

  // A managed connection is opened by id (`buildConnectionPayload` sends `seed:<id>`), so the
  // browser needs none of its credentials: every field the storage layer classifies as secret
  // stays on the server, not only the password.
  it("withholds every credential of a managed:true connection", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "managed-secrets-config.yaml");
    process.env.MANAGED_ES_KEY_ID = "CANARY-MANAGED-KEY-ID";
    process.env.MANAGED_ES_KEY_SECRET = "CANARY-MANAGED-KEY-SECRET";
    process.env.MANAGED_PG_PASSWORD = "CANARY-MANAGED-PG-PASSWORD";
    process.env.MANAGED_MONGO_URI = "mongodb://app:CANARY-MANAGED-URI-PASSWORD@mongo.internal/app";
    process.env.EDITABLE_ES_KEY_ID = "editable-key-id";
    process.env.EDITABLE_ES_KEY_SECRET = "editable-key-secret";
    resetCache();

    try {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      const search = data.connections.find((c: { seedId: string }) => c.seedId === "managed-search");
      const mtls = data.connections.find((c: { seedId: string }) => c.seedId === "managed-mtls");
      const uri = data.connections.find((c: { seedId: string }) => c.seedId === "managed-uri");

      // Control: each is listed, and what is not a credential still reaches the browser.
      expect(search.host).toBe("es.internal");
      expect(mtls.user).toBe("app");
      expect(uri.type).toBe("mongodb");
      expect(mtls.ssl).toEqual({
        mode: "verify-full",
        caCert: "CA-CERTIFICATE-PEM",
        clientCert: "CLIENT-CERTIFICATE-PEM",
      });

      expect("apiKeyId" in search).toBe(false);
      expect("apiKeySecret" in search).toBe(false);
      expect("password" in mtls).toBe(false);
      expect("connectionString" in uri).toBe(false);
      const managedBody = JSON.stringify(data.connections.filter((c: { managed: boolean }) => c.managed));
      for (const canary of [
        "CANARY-MANAGED-KEY-ID",
        "CANARY-MANAGED-KEY-SECRET",
        "CANARY-MANAGED-PG-PASSWORD",
        "CANARY-MANAGED-TLS-CLIENT-KEY",
        "CANARY-MANAGED-URI-PASSWORD",
      ]) {
        expect(managedBody).not.toContain(canary);
      }
    } finally {
      process.env.SEED_CONFIG_PATH = origPath;
      delete process.env.MANAGED_ES_KEY_ID;
      delete process.env.MANAGED_ES_KEY_SECRET;
      delete process.env.MANAGED_PG_PASSWORD;
      delete process.env.MANAGED_MONGO_URI;
      delete process.env.EDITABLE_ES_KEY_ID;
      delete process.env.EDITABLE_ES_KEY_SECRET;
      resetCache();
    }
  });

  // The other side of the same line: an editable seed is copied into the browser to be edited,
  // so it keeps what the editor needs, the API key pair included.
  it("still hands an editable connection its API key pair", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "managed-secrets-config.yaml");
    process.env.MANAGED_ES_KEY_ID = "managed-key-id";
    process.env.MANAGED_ES_KEY_SECRET = "managed-key-secret";
    process.env.MANAGED_PG_PASSWORD = "managed-pg-password";
    process.env.MANAGED_MONGO_URI = "mongodb://app:managed-uri-password@mongo.internal/app";
    process.env.EDITABLE_ES_KEY_ID = "editable-key-id";
    process.env.EDITABLE_ES_KEY_SECRET = "editable-key-secret";
    resetCache();

    try {
      const res = await GET();
      const data = await res.json();
      const editable = data.connections.find((c: { seedId: string }) => c.seedId === "editable-search");

      expect(editable.managed).toBe(false);
      expect(editable.apiKeyId).toBe("editable-key-id");
      expect(editable.apiKeySecret).toBe("editable-key-secret");
    } finally {
      process.env.SEED_CONFIG_PATH = origPath;
      delete process.env.MANAGED_ES_KEY_ID;
      delete process.env.MANAGED_ES_KEY_SECRET;
      delete process.env.MANAGED_PG_PASSWORD;
      delete process.env.MANAGED_MONGO_URI;
      delete process.env.EDITABLE_ES_KEY_ID;
      delete process.env.EDITABLE_ES_KEY_SECRET;
      resetCache();
    }
  });

  it("returns 401 when no session", async () => {
    (getSession as ReturnType<typeof mock>).mockImplementation(() => null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_REQUIRED");
  });

  it("returns empty array when config file missing", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = "/nonexistent/path.yaml";
    resetCache();
    const res = await GET();
    const data = await res.json();
    expect(data.connections).toHaveLength(0);
    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  it("includes credentials for managed:false connections", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "valid-config.yaml",
    );
    process.env.TEST_PG_PASSWORD = "pg-pass";
    process.env.TEST_MYSQL_PASSWORD = "mysql-pass";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-pass";
    resetCache();

    const res = await GET();
    const data = await res.json();
    const unmanaged = data.connections.find((c: { managed: boolean }) => !c.managed);
    expect(unmanaged).toBeDefined();
    expect(unmanaged.password).toBe("mysql-pass");

    process.env.SEED_CONFIG_PATH = origPath;
    delete process.env.TEST_PG_PASSWORD;
    delete process.env.TEST_MYSQL_PASSWORD;
    delete process.env.TEST_MONGO_URI;
    delete process.env.TEST_REDIS_PASSWORD;
    resetCache();
  });

  it("returns no pending seeds when nothing is seeding", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.pendingSeeds).toEqual([]);
  });

  // A `${vault:...}` reference stays unresolved on this path — listing reads no secret —
  // so for a `managed: false` connection the reference string, not a secret, is what
  // reaches the browser. Pinned here rather than in a new file so this suite keeps its
  // single `@/lib/auth` stub (D85).
  it("hands a ${vault:...} reference to an editable connection", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "vault-config.yaml");
    process.env.VAULT_FIXTURE_ENV_PASSWORD = "env-secret";
    resetCache();

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    const editable = data.connections.find((c: { seedId: string }) => c.seedId === "vault-mysql");
    const locked = data.connections.find((c: { seedId: string }) => c.seedId === "vault-postgres");

    expect(editable.password).toBe("${vault:secret/data/prod/mysql#password}");
    expect(locked.password).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("vault-secret");

    process.env.SEED_CONFIG_PATH = origPath;
    delete process.env.VAULT_FIXTURE_ENV_PASSWORD;
    resetCache();
  });

  // An editable seed is copied into the browser to be edited, so the web keeps its credentials. A native client on the
  // bearer channel edits no connection and holds no database credential, so it gets none (docs/OIDC.md).
  describe("an editable seed with its credentials", () => {
    const CANARY = "CANARY-EDITABLE-SEED-PASSWORD";
    let dir: string;
    let origPath: string | undefined;

    beforeEach(() => {
      origPath = process.env.SEED_CONFIG_PATH;
      dir = mkdtempSync(path.join(tmpdir(), "libredb-seed-editable-"));
      const file = path.join(dir, "seed-connections.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: "1",
          connections: [
            {
              id: "editable",
              name: "Editable",
              type: "postgres",
              host: "db.example.internal",
              port: 5432,
              database: "app",
              user: "app",
              password: CANARY,
              roles: ["*"],
              managed: false,
            },
          ],
        }),
      );
      process.env.SEED_CONFIG_PATH = file;
      resetCache();
    });

    afterEach(() => {
      process.env.SEED_CONFIG_PATH = origPath;
      resetCache();
      rmSync(dir, { recursive: true, force: true });
    });

    it("reach a cookie session, which edits it", async () => {
      const data = await (await GET()).json();

      expect(data.connections.find((c: { seedId: string }) => c.seedId === "editable").password).toBe(CANARY);
    });

    it("never reach a bearer session", async () => {
      (getSession as ReturnType<typeof mock>).mockImplementation(() => ({
        role: "user",
        username: "ada@example.test",
        channel: "bearer",
      }));

      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();

      const editable = data.connections.find((c: { seedId: string }) => c.seedId === "editable");
      expect(editable).toMatchObject({ seedId: "editable", managed: false, user: "app" });
      expect("password" in editable).toBe(false);
      expect(JSON.stringify(data)).not.toContain(CANARY);
    });
  });

  it("advertises the sqlite sample while its async seed is in flight", async () => {
    setSqliteSampleSeedState("seeding");
    try {
      const res = await GET();
      const data = await res.json();
      expect(data.pendingSeeds).toEqual([SQLITE_SAMPLE_SEED_ID]);
    } finally {
      setSqliteSampleSeedState("idle");
    }
  });

  it("returns 500 when config is invalid", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "invalid-config.yaml",
    );
    resetCache();

    const res = await GET();
    expect(res.status).toBe(500);

    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  // B37. A 500 alone tells the browser only that this request failed, and a browser
  // that cannot tell "the server serves no seeds" from "the server could not read its
  // seed list" ends up saying the first about connections this application seeds
  // itself. So the failure NAMES itself: the seed configuration is what could not be
  // read, and that is the sentence a user is owed.
  it("names the seed configuration as the thing that failed, not just the request", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(
      path.resolve(__dirname, "../../fixtures/seed-connections"),
      "invalid-config.yaml",
    );
    resetCache();

    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load managed connections",
      reason: SEED_CONFIG_UNREADABLE_REASON,
    });

    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });

  // The other half of the same claim: a failure that is NOT the seed configuration must
  // not be reported as one. Without this arm the reason would be a synonym for 500 and
  // the rail would blame a config file for a broken session cookie.
  it("does not blame the seed configuration for a failure somewhere else", async () => {
    (getSession as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("session store unreachable");
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("Failed to load managed connections");
    expect(body.reason).toBeUndefined();
  });

  it("strips the literal marker from operator entries in literal mode and keeps the response shape", async () => {
    process.env.SEED_LITERAL_VALUES = "true";
    resetCache();
    try {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(Object.keys(data).sort()).toEqual(["cacheHint", "connections", "pendingSeeds"]);
      expect(data.connections.map((c: { seedId: string }) => c.seedId)).toEqual([
        "admin-only",
        "everyone",
        "admin-and-user",
      ]);
      expect(data.connections.filter((c: object) => "literal" in c)).toEqual([]);
    } finally {
      delete process.env.SEED_LITERAL_VALUES;
      resetCache();
    }
  });

  // Discovered connections (CapRover auto-connect spec 9.5 and 10): every role can read this route, so the
  // discovered list reaches admins only, without a password, and the server-side literal marker never leaves.
  describe("with discovered connections", () => {
    const CANARY = "CANARY-DISCOVERED-PASSWORD";
    let discovery: DiscoveryExportFixture;

    beforeEach(() => {
      discovery = writeDiscoveryExport([postgresService("pg", CANARY)]);
      process.env.SEED_DISCOVERY_PATH = discovery.path;
      resetCache();
      resetDiscoveryCache();
    });

    afterEach(() => {
      delete process.env.SEED_DISCOVERY_PATH;
      resetCache();
      resetDiscoveryCache();
      discovery.remove();
    });

    it("hands an admin the discovered connection without its password and without the literal marker", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      const entry = data.connections.find((c: { seedId: string }) => c.seedId === "caprover-pg");

      expect(entry).toMatchObject({
        id: "seed:caprover-pg",
        type: "postgres",
        host: "srv-captain--pg",
        port: 5432,
        user: "postgres",
        database: "appdb",
        group: "CapRover",
        managed: true,
        roles: ["admin"],
      });
      expect("password" in entry).toBe(false);
      expect("literal" in entry).toBe(false);
      expect(data.connections.filter((c: object) => "literal" in c)).toEqual([]);
      expect(JSON.stringify(data)).not.toContain(CANARY);
    });

    it("hands a standard user none of the discovered connections", async () => {
      (getSession as ReturnType<typeof mock>).mockImplementation(() => ({ role: "user", username: "user@test.com" }));

      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      const ids: string[] = data.connections.map((c: { seedId: string }) => c.seedId);

      expect(ids).toContain("everyone");
      expect(ids.filter((id) => id.startsWith("caprover-"))).toEqual([]);
      expect(JSON.stringify(data)).not.toContain(CANARY);
    });

    it("keeps the response shape: connections, cacheHint and pendingSeeds, nothing else", async () => {
      const res = await GET();
      const data = await res.json();
      expect(Object.keys(data).sort()).toEqual(["cacheHint", "connections", "pendingSeeds"]);
      expect(data.cacheHint).toBe(60000);
      expect(data.pendingSeeds).toEqual([]);
    });
  });

  // SEED_LITERAL_VALUES through the real list: every file seed is marked, and the route still answers
  // its usual shape. The marker is removed, a managed seed keeps its password on the server, and an
  // editable seed is handed its `${NAME}` value as written, never the variable's value.
  it("lists a literal seed file without the marker, and an editable ${NAME} value as written", async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "vault-config.yaml");
    process.env.VAULT_FIXTURE_ENV_PASSWORD = "env-secret";
    process.env.SEED_LITERAL_VALUES = "true";
    resetCache();

    try {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      const locked = data.connections.find((c: { seedId: string }) => c.seedId === "vault-postgres");
      const fromEnv = data.connections.find((c: { seedId: string }) => c.seedId === "env-postgres");

      expect("password" in locked).toBe(false);
      expect(fromEnv.password).toBe("${VAULT_FIXTURE_ENV_PASSWORD}");
      expect(data.connections.filter((c: object) => "literal" in c)).toEqual([]);
      expect(JSON.stringify(data)).not.toContain("env-secret");
    } finally {
      process.env.SEED_CONFIG_PATH = origPath;
      delete process.env.VAULT_FIXTURE_ENV_PASSWORD;
      delete process.env.SEED_LITERAL_VALUES;
      resetCache();
    }
  });
});

/*
  Governance mode (docs/GOVERNANCE.md): the list is the session's grants in the governance snapshot, for its identity
  provider subject and whatever its role, each record carrying the credential of its grant level on the server only.
  The browser gets no credential and neither server-only marker, and asks again every 10 seconds, so a grant made or
  revoked reaches the list quickly. While the snapshot cannot be served the route answers 503, never an empty list a
  browser would read as "nothing granted".
*/
describe("GET /api/connections/managed under governance", () => {
  const T = Date.parse("2026-10-15T08:00:00.000Z");
  const TLS_KEY = "CANARY-GOVERNED-TLS-CLIENT-KEY";
  const URI = "postgresql://writer:CANARY-GOVERNED-URI-PASSWORD@orders.db.example.internal/orders";
  const ORDERS = admittedConnection("orders", {
    name: "Orders",
    write: true,
    extra: {
      connectionString: URI,
      ssl: { mode: "verify-full", caCert: "CA-PEM", clientCert: "CERT-PEM", clientKey: TLS_KEY },
    },
  });
  const BILLING = admittedConnection("billing", { name: "Billing" });
  const CRM = admittedConnection("crm", { name: "CRM" });
  const SESSION = { role: "admin", username: "admin@test.com", idpSubject: "admin-subject" };

  beforeEach(() => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    setSystemTime(new Date(T));
    resetGovernanceState();
    (getSession as ReturnType<typeof mock>).mockImplementation(() => SESSION);
  });

  afterEach(() => {
    delete process.env.GOVERNANCE_SOURCE;
    setSystemTime();
    resetGovernanceState();
  });

  it("governance lists only the subject's grants with their access, no secret, literal or grantLevel field and cacheHint 10000", async () => {
    process.env.SEED_CACHE_TTL_MS = "60000";
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, BILLING, CRM],
        [
          { subject: SESSION.idpSubject, connection: ORDERS, level: "write" },
          { subject: SESSION.idpSubject, connection: BILLING, level: "read" },
          { subject: "another-subject", connection: CRM, level: "write" },
        ],
      ),
    );

    try {
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(Object.keys(data).sort()).toEqual(["cacheHint", "connections", "pendingSeeds"]);
      expect(data.cacheHint).toBe(10000);
      expect(data.pendingSeeds).toEqual([]);
      // By name, the admin's own two and not the connection granted to another subject.
      expect(data.connections.map((c: { id: string }) => c.id)).toEqual(["seed:billing", "seed:orders"]);
      expect(data.connections[1]).toEqual({
        id: "seed:orders",
        seedId: "orders",
        name: "Orders",
        type: "postgres",
        host: "orders.db.example.internal",
        port: 5432,
        database: "orders",
        environment: "production",
        user: WRITE_CREDENTIAL.user,
        ssl: { mode: "verify-full", caCert: "CA-PEM", clientCert: "CERT-PEM" },
        queryTimeout: 60000,
        managed: true,
        roles: ["*"],
        createdAt: "2026-10-15T08:00:00.000Z",
        access: "write",
      });
      expect(data.connections[0].access).toBe("read");
      for (const connection of data.connections) {
        for (const field of ["password", "connectionString", "literal", "grantLevel"]) {
          expect(field in connection).toBe(false);
        }
      }
      const body = JSON.stringify(data);
      for (const canary of [TLS_KEY, "CANARY-GOVERNED-URI-PASSWORD", WRITE_CREDENTIAL.password, "crm"]) {
        expect(body).not.toContain(canary);
      }
    } finally {
      delete process.env.SEED_CACHE_TTL_MS;
    }
  });

  it("governance answers 503 GOVERNANCE_UNAVAILABLE while the snapshot is unavailable", async () => {
    // Older than GOVERNANCE_MAX_STALENESS_MS, 120000 by default.
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: SESSION.idpSubject, connection: BILLING, level: "read" }], T - 120_000),
    );

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Connection access is unavailable while this server cannot read its governance source",
      code: "GOVERNANCE_UNAVAILABLE",
    });
  });

  it("governance answers 503 before the first load as well", async () => {
    const res = await GET();

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("GOVERNANCE_UNAVAILABLE");
  });

  it("governance lists nothing for a session without an identity provider subject, whatever its role", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: SESSION.idpSubject, connection: BILLING, level: "read" }]),
    );
    (getSession as ReturnType<typeof mock>).mockImplementation(() => ({ role: "admin", username: "admin@test.com" }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect((await res.json()).connections).toEqual([]);
  });

  // Under governance no seed configuration is read, so no failure here may be reported as one (B37).
  it("governance does not blame the seed configuration for a broken snapshot", async () => {
    // A write grant on a connection without a write credential: only a broken snapshot holds one.
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: SESSION.idpSubject, connection: BILLING, level: "write" }]),
    );

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load managed connections" });
  });
});
