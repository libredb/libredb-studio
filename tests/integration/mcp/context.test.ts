/**
 * The MCP tools' per-request view of one caller's connections (#246).
 *
 * The seed file is read lazily and once per request, and concurrent first acquisitions of one
 * connection and profile open one provider, keyed on the factory's own cache key: the same id
 * with different credentials is a different key, and a failed first acquisition is retried by
 * the next caller. Providers are counted on the real SQLite provider's connect, which the factory
 * calls exactly once for each provider it constructs (src/lib/db/factory.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExecutionProfileError,
  ProviderUnavailableError,
  StudioProfileRefusal,
  UnknownProviderError,
} from "@/lib/db/errors";
import { typeIdRefusal, unknownTypeSentence } from "@/lib/db/type-id";
import { getOrCreateProvider } from "@/lib/db/factory";
import { forgetServerCatalog, installServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { logger } from "@/lib/logger";
import {
  assertAgentCredentialWhereRequired,
  assertReadRootsWhereRequired,
  MCP_CONNECTIONS_UNREADABLE,
  McpConnectionContext,
  mcpCaller,
} from "@/lib/mcp/context";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
import { resetVaultCache } from "@/lib/seed/vault-client";
import {
  countMethod,
  createDuckdbFile,
  createSqliteFile,
  failNextCall,
  gateMethod,
  holdGate,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import { admittedFor, admittedManifest, type EditableEngine } from "../../helpers/package-catalog";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const agentCredentialRequired = legacyRegisterTable("agentCredentialRequired");

const STAND_IN_PASSWORD = ["not", "a", "real", "password"].join("-");
const STAND_IN_AGENT_PASSWORD = ["not", "a", "real", "agent", "password"].join("-");
const STAND_IN_OWNER_PASSWORD = ["not", "a", "real", "owner", "password"].join("-");

pinMcpTestEnvironment();

const ROOT = resolve(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-context-"));
const alice = { username: "alice", role: "admin" } as const;
const bob = { username: "bob", role: "user" } as const;

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A caller's wait that never ends, for an acquisition whose wait the test does not read. */
const noWait = (): OpenWait => ({ signal: new AbortController().signal });

async function visibleIds(context: McpConnectionContext): Promise<string[]> {
  const visible = await context.visibleConnections();
  if (visible === MCP_CONNECTIONS_UNREADABLE) throw new Error("the seed file could not be read");
  return visible.map((connection) => connection.id);
}

function seedShop(): void {
  writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db") }]);
}

async function shopConnection(context: McpConnectionContext) {
  const connection = await context.resolve("seed:shop");
  if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
    throw new Error("the seed connection seed:shop did not resolve");
  return connection;
}

describe("the seed file", () => {
  test("is not read when a context is constructed, only when a tool asks for connections", async () => {
    process.env.SEED_CONFIG_PATH = join(dir, "not-written-yet.json");
    const context = new McpConnectionContext(alice);
    seedShop();

    expect(await visibleIds(context)).toEqual(["seed:shop"]);
  });

  test("is read once per context, so one request sees one list", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const first = await context.visibleConnections();
    writeSeedFile(dir, [{ id: "other", type: "sqlite", database: join(dir, "shop.db") }]);

    expect(await context.visibleConnections()).toBe(first);
    // The control: a new context reads the rewritten file.
    expect(await visibleIds(new McpConnectionContext(alice))).toEqual(["seed:other"]);
  });

  test("that cannot be parsed answers unreadable, and the cause goes to the server log", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ this is not json");
    process.env.SEED_CONFIG_PATH = path;
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const context = new McpConnectionContext(alice);
      expect(await context.visibleConnections()).toBe(MCP_CONNECTIONS_UNREADABLE);
      expect(await context.resolve("seed:shop")).toBe(MCP_CONNECTIONS_UNREADABLE);
      expect(errorLog.mock.calls.map(([message]) => message)).toEqual(["Could not load managed connections for MCP"]);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("holds only the connections opted in with mcp: true", async () => {
    writeSeedFile(dir, [
      { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
      { id: "silent", type: "sqlite", database: join(dir, "shop.db"), mcp: null },
    ]);
    expect(await visibleIds(new McpConnectionContext(alice))).toEqual(["seed:shop"]);
  });

  test("filters connections matching caller's claimRoles when OIDC_ROLE_PREFIX is set", async () => {
    const origProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    const origPrefix = process.env.OIDC_ROLE_PREFIX;
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ROLE_PREFIX = "team-";
    try {
      writeSeedFile(dir, [
        { id: "billing", type: "sqlite", database: join(dir, "shop.db"), roles: ["team-billing"] },
        { id: "analytics", type: "sqlite", database: join(dir, "shop.db"), roles: ["team-analytics"] },
        { id: "public", type: "sqlite", database: join(dir, "shop.db"), roles: ["*"] },
      ]);
      const caller = { username: "charlie", role: "user" as const, claimRoles: ["team-billing"] };
      const context = new McpConnectionContext(caller);
      expect(await visibleIds(context)).toEqual(["seed:billing", "seed:public"]);
    } finally {
      if (origProvider !== undefined) process.env.NEXT_PUBLIC_AUTH_PROVIDER = origProvider;
      else delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
      if (origPrefix !== undefined) process.env.OIDC_ROLE_PREFIX = origPrefix;
      else delete process.env.OIDC_ROLE_PREFIX;
    }
  });
});

describe("mcpCaller", () => {
  const authInfo = (extra: Record<string, unknown> | undefined) => ({
    token: "not-a-real-token",
    clientId: "test:caller",
    scopes: ["mcp:read"],
    ...(extra === undefined ? {} : { extra }),
  });

  test("reads the username, role and claim roles the verifier put on the token", () => {
    expect(mcpCaller(authInfo({ username: "alice", role: "user", claimRoles: ["db-readers"] }))).toEqual({
      username: "alice",
      role: "user",
      claimRoles: ["db-readers"],
    });
  });

  test("refuses an identity with no username or an unknown role, rather than serving an anonymous caller", () => {
    const refusal = "The verified MCP identity carries no username and role";
    expect(() => mcpCaller(authInfo(undefined))).toThrow(refusal);
    expect(() => mcpCaller(authInfo({ username: "", role: "admin" }))).toThrow(refusal);
    expect(() => mcpCaller(authInfo({ username: "alice", role: "owner" }))).toThrow(refusal);
  });
});

describe("resolve", () => {
  test("answers a visible connection, and the same null for an id that does not exist", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);

    expect(await context.resolve("seed:shop")).toMatchObject({ seedId: "shop" });
    expect(await context.resolve("seed:missing")).toBeNull();
    expect(await context.resolve("shop")).toBeNull();
  });
});

describe("reachableTypes", () => {
  const savedGovernance = process.env.GOVERNANCE_SOURCE;

  beforeEach(() => {
    delete process.env.GOVERNANCE_SOURCE;
  });

  afterEach(() => {
    if (savedGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedGovernance;
  });

  test("answers the engines of the connections the caller can read, and no other", async () => {
    writeSeedFile(dir, [
      { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
      { id: "mongo", type: "mongodb", host: "127.0.0.1", port: 27017, database: "app" },
      { id: "hidden", type: "postgres", host: "127.0.0.1", port: 5432, mcp: false },
      { id: "users", type: "duckdb", database: join(dir, "users.duckdb"), roles: ["user"] },
    ]);
    expect(await new McpConnectionContext(alice).reachableTypes()).toEqual(new Set(["sqlite", "mongodb"]));
  });

  test("leaves out a connection no MCP open can serve for the caller", async () => {
    writeSeedFile(dir, [
      { id: "files", type: "sqlite", database: join(dir, "shop.db"), roles: ["*"] },
      { id: "warehouse", type: "duckdb", database: join(dir, "warehouse.duckdb"), roles: ["*"] },
    ]);
    expect(await new McpConnectionContext(bob).reachableTypes()).toEqual(new Set(["duckdb"]));
    // A seed another role can use opens with file access denied for every caller, admins included.
    writeSeedFile(dir, [{ id: "files", type: "sqlite", database: join(dir, "shop.db"), roles: ["*"] }]);
    expect(await new McpConnectionContext(alice).reachableTypes()).toEqual(new Set());
  });

  test("reachableTypes leaves out a seed whose type names no provider", async () => {
    writeSeedFile(dir, [
      { id: "acme", type: "acmefoo" },
      { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    ]);
    expect(await new McpConnectionContext(alice).reachableTypes()).toEqual(new Set(["sqlite"]));
  });

  test("answers unreadable for a seed file that cannot be parsed", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ this is not json");
    process.env.SEED_CONFIG_PATH = path;
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await new McpConnectionContext(alice).reachableTypes()).toBe(MCP_CONNECTIONS_UNREADABLE);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("answers no engine when the seed file is absent", async () => {
    process.env.SEED_CONFIG_PATH = join(dir, "never-written.json");
    expect(await new McpConnectionContext(alice).reachableTypes()).toEqual(new Set());
  });

  test("reads the listing the context already holds, so one request reads the seed file once", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    expect(await context.reachableTypes()).toEqual(new Set(["sqlite"]));
    writeSeedFile(dir, [{ id: "other", type: "sqlite", database: join(dir, "shop.db") }]);
    expect(await visibleIds(context)).toEqual(["seed:shop"]);
  });
});

describe("acquire", () => {
  test("joins twelve concurrent first acquisitions of one connection and profile into one provider", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const acquisitions = Array.from({ length: 12 }, () => context.acquire(connection, "agent-read-only", noWait()));
      await gate.entered;
      await holdGate();
      expect(gate.calls).toBe(1);
      gate.release();
      const providers = await Promise.all(acquisitions);

      expect(gate.calls).toBe(1);
      expect(new Set(providers).size).toBe(1);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  test("an acquisition hands the factory the caller's wait", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const leaving = new AbortController();
      const left = context.acquire(connection, "agent-read-only", { signal: leaving.signal });
      const staying = context.acquire(connection, "agent-read-only", noWait());
      await gate.entered;
      const reason = new Error("the caller stopped waiting");
      leaving.abort(reason);

      // The open releases the caller whose wait ended with its reason, while it goes on for the one still waiting.
      expect(await left.catch((error: unknown) => error)).toBe(reason);
      gate.release();
      const provider = await staying;
      expect(provider.isConnected()).toBe(true);
      expect(gate.calls).toBe(1);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  test("opens one provider per profile", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      const [readOnly, operations] = await Promise.all([
        context.acquire(connection, "agent-read-only", noWait()),
        context.acquire(connection, "agent-operations", noWait()),
      ]);

      expect(connects.calls).toBe(2);
      expect(readOnly).not.toBe(operations);
    } finally {
      connects.restore();
    }
  });

  test("does not join two connections that share an id but not their credentials", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const other = { ...connection, password: "a-different-credential-written-in-words" };
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      await Promise.all([
        context.acquire(connection, "agent-read-only", noWait()),
        context.acquire(other, "agent-read-only", noWait()),
      ]);

      expect(connects.calls).toBe(2);
    } finally {
      connects.restore();
    }
  });

  test("lets the next caller retry after a first acquisition that failed", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const failing = failNextCall(SQLiteProvider.prototype, "connect", new Error("the first open failed"));
    try {
      await expect(context.acquire(connection, "agent-read-only", noWait())).rejects.toThrow("the first open failed");
      const provider = await context.acquire(connection, "agent-read-only", noWait());

      expect(provider.isConnected()).toBe(true);
      expect(failing.calls).toBe(2);
    } finally {
      failing.restore();
    }
  });

  test.each([[["*"]], [["admin", "user"]]])(
    "a SQLite seed offered to %p opens for no caller, admin included",
    async (roles) => {
      // SQLite's drivers cannot confine a statement's file access, so the caller's posture reaches the
      // profiled handle (#1523): on a seed a non-admin role can use that posture is denied for every
      // caller, and the acquisition is refused at connect rather than served read-only. Each caller lists
      // its own copy of the seed, and alice's copy of the second seed names ["admin"] alone.
      writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db"), roles }]);
      for (const caller of [alice, bob]) {
        const context = new McpConnectionContext(caller);
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next caller asks.
        const connection = await shopConnection(context);
        // oxlint-disable-next-line no-await-in-loop -- as above.
        await expect(context.acquire(connection, "agent-read-only", noWait())).rejects.toThrow(
          "require an administrator",
        );
      }
    },
  );

  test("an admin's operations acquisition on an admin-only DuckDB seed borrows the editor's open handle", async () => {
    // The non-admin DuckDB file-access change with B49: the editor holds the file under the admin
    // posture, which is the posture this caller gets in the editor on a seed only admins can use, so
    // the borrow lends it that handle rather than opening a second one beside it.
    const file = join(dir, "admin-only.duckdb");
    await createDuckdbFile(file, ["CREATE TABLE t (id INTEGER)"]);
    writeSeedFile(dir, [{ id: "warehouse", type: "duckdb", database: file, roles: ["admin"] }]);
    const context = new McpConnectionContext(alice);
    const connection = await context.resolve("seed:warehouse");
    if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
      throw new Error("seed:warehouse did not resolve");
    const editor = await getOrCreateProvider(connection, {}, { allowExternalFileAccess: true });

    expect(await context.acquire(connection, "agent-operations", noWait())).toBe(editor);
  });

  test("a user's operations acquisition is never lent an admin's full-reach handle on the same file", async () => {
    // The MCP context must pass the CALLER'S own editor posture to the acquisition, not a constant.
    // A user on a roles ["*"] mcp seed gets the denied posture, so even with an admin's full-reach
    // handle open on the same file (an admin-only record naming it), the user's agent-operations
    // borrow must not reach it. If the context passed a constant allow posture instead, the user
    // would borrow the admin's handle: a wider handle than its own.
    const file = join(dir, "shared-by-roles.duckdb");
    await createDuckdbFile(file, ["CREATE TABLE t (id INTEGER)"]);
    writeSeedFile(dir, [
      { id: "warehouse", type: "duckdb", database: file, roles: ["*"], mcp: true },
      { id: "warehouse-admin", type: "duckdb", database: file, roles: ["admin"], mcp: true },
    ]);
    // An admin's full-reach handle holds the file, opened under the admin-only record.
    const adminContext = new McpConnectionContext(alice);
    const adminConnection = await adminContext.resolve("seed:warehouse-admin");
    if (adminConnection === null || adminConnection === MCP_CONNECTIONS_UNREADABLE)
      throw new Error("seed:warehouse-admin did not resolve");
    const adminEditor = await getOrCreateProvider(adminConnection, {}, { allowExternalFileAccess: true });

    const context = new McpConnectionContext(bob);
    const connection = await context.resolve("seed:warehouse");
    if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
      throw new Error("seed:warehouse did not resolve");

    if (process.platform === "win32") {
      // Windows refuses any second handle on a file this process holds, and the user must not borrow
      // the admin's, so the acquisition is refused rather than served the wider handle.
      await expect(context.acquire(connection, "agent-operations", noWait())).rejects.toThrow();
    } else {
      const acquired = await context.acquire(connection, "agent-operations", noWait());
      expect(acquired).not.toBe(adminEditor);
    }
  });

  test("an admin's and a user's read acquisitions of a DuckDB seed offered to both are one provider", async () => {
    // Each caller lists its own copy, ["admin"] for alice and ["user"] for bob; the posture, and so the
    // profiled key, comes from the operator's list, so both are served by one handle on the file.
    const file = join(dir, "offered-to-both.duckdb");
    await createDuckdbFile(file, ["CREATE TABLE t (id INTEGER)"]);
    writeSeedFile(dir, [{ id: "warehouse", type: "duckdb", database: file, roles: ["admin", "user"] }]);
    const providers = [];
    for (const caller of [alice, bob]) {
      const context = new McpConnectionContext(caller);
      // oxlint-disable-next-line no-await-in-loop -- one caller at a time.
      const connection = await context.resolve("seed:warehouse");
      if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
        throw new Error("seed:warehouse did not resolve");
      // oxlint-disable-next-line no-await-in-loop -- as above.
      providers.push(await context.acquire(connection, "agent-read-only", noWait()));
    }
    expect(providers[1]).toBe(providers[0]);
  });
});

describe("a seed's Vault reference", () => {
  const REFERENCE = "${vault:secret/data/mcp/warehouse#password}";
  const VAULT_ADDR = "http://127.0.0.1:8200";
  const realFetch = globalThis.fetch;
  let vaultCalls: string[] = [];

  beforeEach(() => {
    vaultCalls = [];
    resetVaultCache();
    process.env.VAULT_ADDR = VAULT_ADDR;
    process.env.VAULT_TOKEN = "not-a-real-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.SEED_LITERAL_VALUES;
    resetVaultCache();
  });

  function vaultAnswers(status: number, body: unknown): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  function seedWarehouse(): void {
    writeSeedFile(dir, [
      { id: "warehouse", type: "postgres", host: "127.0.0.1", port: 5432, user: "reader", password: REFERENCE },
    ]);
  }

  /** The password each Postgres provider was opened with, and the open stopped there, before any socket. */
  function capturePasswords(): { readonly passwords: unknown[]; restore(): void } {
    const passwords: unknown[] = [];
    const connect = spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (
      this: PostgresProvider,
    ) {
      passwords.push(this.config.password);
      throw new Error("stopped after the open read its password");
    });
    return { passwords, restore: () => connect.mockRestore() };
  }

  async function warehouse(context: McpConnectionContext) {
    const connection = await context.resolve("seed:warehouse");
    if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
      throw new Error("seed:warehouse did not resolve");
    return connection;
  }

  test("is not read by reachableTypes, which answers the engine from the listing alone", async () => {
    vaultAnswers(200, { data: { data: { password: "not-a-real-password" } } });
    seedWarehouse();
    expect(await new McpConnectionContext(alice).reachableTypes()).toEqual(new Set(["postgres"]));
    expect(vaultCalls).toEqual([]);
  });

  test("is read from Vault when a tool opens the connection, so the provider gets the secret and not the text", async () => {
    vaultAnswers(200, { data: { data: { password: "not-a-real-password" } } });
    seedWarehouse();
    const context = new McpConnectionContext(alice);
    const connection = await warehouse(context);
    // Listing reads no secret: the connection a tool is handed still carries the reference.
    expect(connection.password).toBe(REFERENCE);
    expect(vaultCalls).toEqual([]);
    const captured = capturePasswords();
    try {
      await expect(context.acquire(connection, "agent-read-only", noWait())).rejects.toThrow("stopped after the open");
      await expect(context.acquire(connection, "agent-operations", noWait())).rejects.toThrow("stopped after the open");
    } finally {
      captured.restore();
    }

    expect(captured.passwords).toEqual(["not-a-real-password", "not-a-real-password"]);
    expect(vaultCalls).toEqual([`${VAULT_ADDR}/v1/secret/data/mcp/warehouse`]);
  });

  test("that Vault cannot answer refuses the open in Studio's words, naming the connection and opening nothing", async () => {
    vaultAnswers(503, { errors: ["not-a-real-vault-detail"] });
    seedWarehouse();
    const context = new McpConnectionContext(alice);
    const connection = await warehouse(context);
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const captured = capturePasswords();
    let refusal: unknown;
    let logged: unknown[][] = [];
    try {
      refusal = await context.acquire(connection, "agent-read-only", noWait()).catch((error: unknown) => error);
      logged = [...errors.mock.calls];
    } finally {
      captured.restore();
      errors.mockRestore();
    }

    expect(refusal).toBeInstanceOf(ExecutionProfileError);
    const { message, reasonCode } = refusal as ExecutionProfileError;
    expect(reasonCode).toBe("CONNECTION_SECRET_UNRESOLVABLE");
    expect(message).toBe(
      'Connection "seed:warehouse" could not be opened: a secret reference in its seed entry could not be read from Vault, so nothing was sent to the database. The server log names the cause.',
    );
    // No fallback: no provider was opened, with the reference or without a password.
    expect(captured.passwords).toEqual([]);
    // The cause is the server log's, never the caller's.
    expect(message).not.toContain("503");
    expect(message).not.toContain("secret/data/mcp/warehouse");
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[1])).toContain("HTTP 503");
  });

  test("of a malformed reference is refused the same way, and its text reaches no caller", async () => {
    vaultAnswers(200, {});
    writeSeedFile(dir, [
      { id: "warehouse", type: "postgres", host: "127.0.0.1", user: "reader", password: "${vault:not-a-reference" },
    ]);
    const context = new McpConnectionContext(alice);
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    let refusal: unknown;
    try {
      refusal = await context
        .acquire(await warehouse(context), "agent-read-only", noWait())
        .catch((error: unknown) => error);
    } finally {
      errors.mockRestore();
    }

    expect((refusal as ExecutionProfileError).reasonCode).toBe("CONNECTION_SECRET_UNRESOLVABLE");
    expect((refusal as Error).message).not.toContain("not-a-reference");
    expect(vaultCalls).toEqual([]);
  });

  test("that fails for a reason other than Vault rethrows that error, so its cause is not hidden behind the refusal", async () => {
    // A fetch that answers no Response makes the Vault read throw a plain TypeError, the shape of a programming error.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return null;
    }) as unknown as typeof fetch;
    seedWarehouse();
    const context = new McpConnectionContext(alice);
    const connection = await warehouse(context);
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const captured = capturePasswords();
    let refusal: unknown;
    let logged: unknown[][] = [];
    try {
      refusal = await context.acquire(connection, "agent-read-only", noWait()).catch((error: unknown) => error);
      logged = [...errors.mock.calls];
    } finally {
      captured.restore();
      errors.mockRestore();
    }

    expect(vaultCalls).toEqual([`${VAULT_ADDR}/v1/secret/data/mcp/warehouse`]);
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal).not.toBeInstanceOf(ExecutionProfileError);
    expect(logged).toEqual([]);
    expect(captured.passwords).toEqual([]);
  });

  test("on a literal connection is the text it is, and Vault is never asked", async () => {
    process.env.SEED_LITERAL_VALUES = "true";
    vaultAnswers(200, { data: { data: { password: "not-a-real-password" } } });
    seedWarehouse();
    const context = new McpConnectionContext(alice);
    const captured = capturePasswords();
    try {
      await expect(context.acquire(await warehouse(context), "agent-read-only", noWait())).rejects.toThrow(
        "stopped after the open",
      );
    } finally {
      captured.restore();
    }

    expect(captured.passwords).toEqual([REFERENCE]);
    expect(vaultCalls).toEqual([]);
  });
});

describe("a seed's agent credential", () => {
  const VAULT_ADDR = "http://127.0.0.1:8200";
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.MCP_CONTEXT_AGENT_USER;
    resetVaultCache();
  });

  /** The user and password each Postgres provider was opened with, and the open stopped there, before any socket. */
  function captureLogins(): { readonly logins: unknown[][]; restore(): void } {
    const logins: unknown[][] = [];
    const connect = spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (
      this: PostgresProvider,
    ) {
      logins.push([this.config.user, this.config.password]);
      throw new Error("stopped after the open read its login");
    });
    return { logins, restore: () => connect.mockRestore() };
  }

  test("is what MCP signs in with, its references resolved, and never the seed's own login", async () => {
    process.env.VAULT_ADDR = VAULT_ADDR;
    process.env.VAULT_TOKEN = "not-a-real-token";
    process.env.MCP_CONTEXT_AGENT_USER = "agent_reader";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { data: { password: STAND_IN_AGENT_PASSWORD } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    writeSeedFile(dir, [
      {
        id: "warehouse",
        type: "postgres",
        host: "127.0.0.1",
        port: 5432,
        user: "owner",
        password: STAND_IN_OWNER_PASSWORD,
        agentUser: "${MCP_CONTEXT_AGENT_USER}",
        agentPassword: "${vault:secret/data/mcp/agent#password}",
      },
    ]);
    const context = new McpConnectionContext(alice);
    const connection = await context.resolve("seed:warehouse");
    if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
      throw new Error("seed:warehouse did not resolve");
    const captured = captureLogins();
    try {
      await Promise.all(
        (["agent-read-only", "agent-operations"] as const).map((profile) =>
          expect(context.acquire(connection, profile, noWait())).rejects.toThrow("stopped after the open"),
        ),
      );
    } finally {
      captured.restore();
    }

    expect(captured.logins).toEqual([
      ["agent_reader", STAND_IN_AGENT_PASSWORD],
      ["agent_reader", STAND_IN_AGENT_PASSWORD],
    ]);
  });
});

describe("an engine MCP reads only beneath read roots", () => {
  const listed = (fields: Record<string, unknown> = {}): ManagedConnection => ({
    id: "seed:plant",
    name: "plant",
    type: "opcua",
    host: "opc.tcp://plc.ornek.net:4840/",
    createdAt: new Date(),
    managed: true,
    roles: ["*"],
    seedId: "plant",
    ...fields,
  });

  test("refuses a connection that declares none in Studio's words, naming the connection", () => {
    let refusal: unknown;
    try {
      assertReadRootsWhereRequired(listed());
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ExecutionProfileError);
    expect((refusal as ExecutionProfileError).reasonCode).toBe("READ_ROOTS_REQUIRED");
    expect((refusal as Error).message).toBe(
      'Connection "seed:plant" is read by MCP only beneath read roots its seed entry declares, and it declares none: an operator sets agentReadRoots on this seed.',
    );
  });

  test("admits one that declares roots, and every connection of an engine the registry does not name", () => {
    expect(() => assertReadRootsWhereRequired(listed({ agentReadRoots: ["nsu=urn:plant;s=Line1"] }))).not.toThrow();
    expect(() => assertReadRootsWhereRequired({ ...listed(), type: "postgres" })).not.toThrow();
  });

  test("an acquisition refuses it before anything is resolved or opened", async () => {
    const context = new McpConnectionContext(mcpCaller({ extra: { role: "admin", username: "alice" } } as never));
    await expect(context.acquire(listed(), "agent-read-only", noWait())).rejects.toMatchObject({
      reasonCode: "READ_ROOTS_REQUIRED",
    });
  });
});

describe("an engine MCP reads only under an agent credential", () => {
  const listed = (type: DatabaseType, fields: Record<string, string> = {}): ManagedConnection => ({
    id: "seed:store",
    name: "store",
    type,
    createdAt: new Date(),
    managed: true,
    roles: ["*"],
    seedId: "store",
    ...fields,
  });
  const required = (type: DatabaseType) => ({
    agentCredentialRequired: type === "postgres" || agentCredentialRequired[type],
  });

  test("refuses a connection with no agent credential in Studio's words, naming the connection", () => {
    let refusal: unknown;
    try {
      assertAgentCredentialWhereRequired(listed("postgres", { user: "owner", password: STAND_IN_PASSWORD }), required);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ExecutionProfileError);
    expect((refusal as ExecutionProfileError).reasonCode).toBe("AGENT_CREDENTIAL_REQUIRED");
    expect((refusal as Error).message).toBe(
      'Connection "seed:store" is read by MCP only under a read credential of its own (agentUser and agentPassword), and it has none: an operator sets agentUser and agentPassword on this seed.',
    );
    expect((refusal as Error).message).not.toContain(STAND_IN_PASSWORD);
  });

  test("admits one that sets either field, which the factory then holds to the engine's form", () => {
    expect(() =>
      assertAgentCredentialWhereRequired(listed("postgres", { agentUser: "agent" }), required),
    ).not.toThrow();
    expect(() =>
      assertAgentCredentialWhereRequired(listed("postgres", { agentPassword: STAND_IN_PASSWORD }), required),
    ).not.toThrow();
  });

  test("admits every connection of an engine the registry does not name", () => {
    expect(() => assertAgentCredentialWhereRequired(listed("mysql"), required)).not.toThrow();
    expect(() => assertAgentCredentialWhereRequired(listed("postgres"))).not.toThrow();
  });
});

describe("the context's source", () => {
  test("carries none of the six test seams the pre-SDK context exposed", () => {
    const source = readFileSync(join(ROOT, "src/lib/mcp/context.ts"), "utf8");
    // The control: this is the file that defines the context.
    expect(source).toContain("export class McpConnectionContext");
    for (const seam of [
      "testMockProviders",
      "setCachedProvider",
      "resetGlobalCache",
      "disconnectActiveProviders",
      "disconnectAll",
      "closeAll",
    ]) {
      expect(source).not.toContain(seam);
    }
    expect(existsSync(join(ROOT, "src/lib/mcp/guards/cancellation.ts"))).toBe(false);
  });
});

// A connection of an engine only a provider package serves (docs/providers/CONTRACT.md, clause C-107): the open's two
// checks read the server's engine catalog, so a refused package's engine is answered PROVIDER_UNAVAILABLE naming the
// refusal code, as every route answers it, and an admitted package's engine is read by its record's grants: with no
// register row each check's grant is at its restrictive value, which no package's open can meet.
describe("a connection of an engine a provider package serves or a refused package names", () => {
  const listed = (type: string): ManagedConnection =>
    ({
      id: "seed:acme",
      name: "Acme Store",
      type,
      host: "db.acme.internal",
      createdAt: new Date(),
      managed: true,
      roles: ["*"],
      seedId: "acme",
    }) as unknown as ManagedConnection;

  beforeEach(() => {
    installServerCatalog(
      composeServerCatalog(
        [admittedFor("acme-mcp-served", admittedManifest("acmemcpserved"))],
        [{ name: "acme-mcp-gone", version: "1.0.0", engines: ["acmemcpgone"], code: "PROVIDER_LOAD_FAILED" }],
        STUDIO_GRANT_REGISTER,
      ),
    );
  });

  afterEach(() => {
    forgetServerCatalog();
  });

  test("both open checks refuse a refused package's engine as PROVIDER_UNAVAILABLE naming the code, and read an admitted one's grants from its record", () => {
    const checks = [
      [assertAgentCredentialWhereRequired, "AGENT_CREDENTIAL_REQUIRED"],
      [assertReadRootsWhereRequired, "READ_ROOTS_REQUIRED"],
    ] as const;
    for (const [check, code] of checks) {
      let gone: unknown;
      try {
        check(listed("acmemcpgone"));
      } catch (error) {
        gone = error;
      }
      expect(gone).toBeInstanceOf(ProviderUnavailableError);
      expect((gone as ProviderUnavailableError).code).toBe("PROVIDER_UNAVAILABLE");
      expect((gone as ProviderUnavailableError).codes).toEqual(["PROVIDER_LOAD_FAILED"]);
      let served: unknown;
      try {
        check(listed("acmemcpserved"));
      } catch (error) {
        served = error;
      }
      // No register row: the grant each check reads is at its restrictive value.
      expect(served).toBeInstanceOf(StudioProfileRefusal);
      expect((served as StudioProfileRefusal).reasonCode).toBe(code);
    }
  });
});

// An admitted package's engine whose register row grants it MCP exposure: both open checks read its grants from its
// record, and the context opens its metadata session through its package, the package's own `open`, once per key. A
// package's open receives no agent credential and no read roots (C-109), so a record that requires either is refused
// by name before any open, whatever the connection carries.
describe("a connection of an engine an admitted provider package serves", () => {
  const OPEN = "acmemcpctxopen";
  const CRED = "acmemcpctxcred";
  const ROOTS = "acmemcpctxroots";
  const providers = scratchDirectory("studio-mcp-context-packages-");
  const exposed = (engine: EditableEngine) => {
    engine.mcp = { ...engine.mcp, exposable: true };
  };
  const pair = { form: "pair", supersededBy: [] } as const;
  const listed = (type: string, fields: Record<string, unknown> = {}): ManagedConnection =>
    ({
      id: "seed:acme",
      name: "Acme Store",
      type,
      host: "db.acme.internal",
      createdAt: new Date(),
      managed: true,
      roles: ["*"],
      seedId: "acme",
      ...fields,
    }) as unknown as ManagedConnection;
  /** Hooks that answer each open with a fresh handle and record the engine whose `open` was called. */
  const opening = (engine: string, opened: string[]) =>
    setHooks(engine, {
      open: () => {
        opened.push(engine);
        return Promise.resolve({ handle: { session: randomUUID() } });
      },
      close: () => Promise.resolve(),
    });

  beforeAll(async () => {
    installHostCore(createHostCore(), "test");
    const row = { exposable: true, agentCredentialRequired: false, readRootsRequired: false } as const;
    await admitSessionPackages(
      providers,
      [
        { name: "acme-mcp-ctx-open", engine: OPEN, edit: exposed },
        {
          name: "acme-mcp-ctx-cred",
          engine: CRED,
          edit: (engine) => {
            exposed(engine);
            engine.mcp = { ...engine.mcp, agentCredentialRequired: true };
            engine.connection.agentCredential = pair;
          },
        },
        { name: "acme-mcp-ctx-roots", engine: ROOTS, edit: exposed },
      ],
      {
        [OPEN]: { ...row, deniedFileAccessRefusal: null },
        [CRED]: {
          ...row,
          deniedFileAccessRefusal: null,
          agentCredentialRequired: true,
          agentCredentialForm: null,
          agentCredential: pair,
        },
        [ROOTS]: { ...row, deniedFileAccessRefusal: null, readRootsRequired: true },
      },
    );
  });

  afterAll(() => {
    forgetServerCatalog();
    forgetHostCore();
    removeScratch(providers);
  });

  test("both open checks open a package engine's connection through its package", async () => {
    const opened: string[] = [];
    opening(OPEN, opened);
    expect(() => assertAgentCredentialWhereRequired(listed(OPEN))).not.toThrow();
    expect(() => assertReadRootsWhereRequired(listed(OPEN))).not.toThrow();
    const connection = listed(OPEN);
    const context = new McpConnectionContext(alice);
    const first = await context.metadataTarget(connection, noWait());
    const again = await context.metadataTarget(connection, noWait());
    const other = await new McpConnectionContext(alice).metadataTarget(listed(OPEN), noWait());
    expect(opened).toEqual([OPEN]);
    expect(again.session).toBe(first.session);
    expect(other.session).toBe(first.session);
  });

  test("a package engine whose record requires an agent credential or read roots is refused before any open, by name", async () => {
    const opened: string[] = [];
    opening(CRED, opened);
    opening(ROOTS, opened);
    // Each row grants exposure beside the requirement, so only the requirement refuses.
    expect(servedEngineRecord(CRED).grants).toMatchObject({ exposable: true, agentCredentialRequired: true });
    expect(servedEngineRecord(ROOTS).grants).toMatchObject({ exposable: true, readRootsRequired: true });
    const context = new McpConnectionContext(alice);
    for (const fields of [{}, { agentUser: "agent", agentPassword: randomUUID() }]) {
      const refusal = await context.metadataTarget(listed(CRED, fields), noWait()).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(StudioProfileRefusal);
      expect((refusal as StudioProfileRefusal).reasonCode).toBe("AGENT_CREDENTIAL_REQUIRED");
      expect((refusal as Error).message).toBe(
        'Connection "seed:acme" is read by MCP only under a read credential of its own, and its engine\'s session opens through its provider package, which receives none, so MCP cannot read it: an operator reads it in the editor instead.',
      );
    }
    for (const fields of [{}, { agentReadRoots: ["root"] }]) {
      const refusal = await context.metadataTarget(listed(ROOTS, fields), noWait()).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(StudioProfileRefusal);
      expect((refusal as StudioProfileRefusal).reasonCode).toBe("READ_ROOTS_REQUIRED");
      expect((refusal as Error).message).toBe(
        'Connection "seed:acme" is read by MCP only beneath read roots its seed entry declares, and its engine\'s session opens through its provider package, which receives none, so MCP cannot read it: an operator reads it in the editor instead.',
      );
    }
    expect(opened).toEqual([]);
  });

  test("the metadata target of a legacy engine's connection is a host defect: MCP reads it under the operations profile", async () => {
    const refusal = await new McpConnectionContext(alice)
      .metadataTarget(listed("postgres"), noWait())
      .catch((error: unknown) => error);
    expect((refusal as Error).message).toBe(
      "MCP reads a legacy engine's schema under the agent-operations profile (`acquire`), never on its metadata session: a host defect.",
    );
  });
});

describe("a connection whose type names no provider (FND-1)", () => {
  const listed = (type: unknown, fields: Record<string, unknown> = {}): ManagedConnection =>
    ({
      id: "seed:acme",
      name: "Acme Store",
      type,
      host: "db.acme.internal",
      createdAt: new Date(),
      managed: true,
      roles: ["*"],
      seedId: "acme",
      ...fields,
    }) as unknown as ManagedConnection;

  test("both open checks refuse a type that is no type id by name before their table is read", () => {
    for (const type of ["acmefoo", "constructor", undefined] as unknown[]) {
      for (const check of [assertAgentCredentialWhereRequired, assertReadRootsWhereRequired]) {
        let thrown: unknown;
        try {
          check(listed(type));
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(UnknownProviderError);
        expect((thrown as UnknownProviderError).message).toBe(typeIdRefusal(type)?.sentence as string);
      }
    }
  });

  test("an acquisition refuses a connection whose type names no provider before any secret is read", async () => {
    const realFetch = globalThis.fetch;
    const vaultCalls: string[] = [];
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "not-a-real-token";
    resetVaultCache();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const context = new McpConnectionContext(alice);
      const refusal = await context
        .acquire(listed("acmefoo", { password: "${vault:secret/data/acme#password}" }), "agent-read-only", noWait())
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(UnknownProviderError);
      expect((refusal as UnknownProviderError).message).toBe(unknownTypeSentence("acmefoo"));
      expect(vaultCalls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.VAULT_ADDR;
      delete process.env.VAULT_TOKEN;
      resetVaultCache();
    }
  });
});
