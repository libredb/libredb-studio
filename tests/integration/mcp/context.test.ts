/**
 * The MCP tools' per-request view of one caller's connections (#246).
 *
 * The seed file is read lazily and once per request, and concurrent first acquisitions of one
 * connection and profile open one provider, keyed on the factory's own cache key: the same id
 * with different credentials is a different key, and a failed first acquisition is retried by
 * the next caller. Providers are counted on the real SQLite provider's connect, which the factory
 * calls exactly once for each provider it constructs (src/lib/db/factory.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { logger } from "@/lib/logger";
import { MCP_CONNECTIONS_UNREADABLE, McpConnectionContext } from "@/lib/mcp/context";
import {
  countMethod,
  createSqliteFile,
  failNextCall,
  gateMethod,
  holdGate,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";

pinMcpTestEnvironment();

const ROOT = resolve(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-context-"));
const alice = { username: "alice", role: "admin" } as const;

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

describe("acquire", () => {
  test("joins twelve concurrent first acquisitions of one connection and profile into one provider", async () => {
    seedShop();
    const context = new McpConnectionContext(alice);
    const connection = await shopConnection(context);
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const acquisitions = Array.from({ length: 12 }, () => context.acquire(connection, "agent-read-only"));
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

  test("the same hold without the join opens twelve providers, so the case above can tell the two apart", async () => {
    seedShop();
    const connection = await shopConnection(new McpConnectionContext(alice));
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const acquisitions = Array.from({ length: 12 }, () =>
        acquireExecutionProfileProvider(connection, "agent-read-only"),
      );
      await gate.entered;
      await holdGate();
      expect(gate.calls).toBe(12);
      gate.release();
      const providers = new Set(await Promise.all(acquisitions));
      expect(providers.size).toBe(12);
      await Promise.all([...providers].map((provider) => provider.disconnect()));
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
        context.acquire(connection, "agent-read-only"),
        context.acquire(connection, "agent-operations"),
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
      await Promise.all([context.acquire(connection, "agent-read-only"), context.acquire(other, "agent-read-only")]);

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
      await expect(context.acquire(connection, "agent-read-only")).rejects.toThrow("the first open failed");
      const provider = await context.acquire(connection, "agent-read-only");

      expect(provider.isConnected()).toBe(true);
      expect(failing.calls).toBe(2);
    } finally {
      failing.restore();
    }
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
