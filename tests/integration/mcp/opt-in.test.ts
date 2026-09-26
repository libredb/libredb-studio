/**
 * Which connections an MCP token reaches (#246): only seed entries that opt in with mcp: true,
 * within the role filter, never the built-in samples; and a seed file that cannot be loaded is an
 * explicit error on every tool, while initialize and tools/list, which read no connection, work.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MCP_CONNECTIONS_UNREADABLE_TEXT } from "@/lib/mcp/context";
import { MCP_NOT_VISIBLE_TEXT } from "@/lib/mcp/output";
import { resetCache } from "@/lib/seed";
import { createSqliteFile, pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-opt-in-"));
const admin = handlerServe(testAuthInfo({ username: "alice", role: "admin" }));
const user = handlerServe(testAuthInfo({ username: "bob", role: "user" }));
const SAMPLE_PATHS = ["SQLITE_EMBEDDED_SAMPLE_PATH", "LIBREDB_EMBEDDED_SAMPLE_PATH"] as const;

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE users (id INTEGER PRIMARY KEY)"]);
});

afterEach(async () => {
  for (const name of SAMPLE_PATHS) delete process.env[name];
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function callTool(serve: typeof admin, name: string, args: Record<string, unknown>) {
  const session = await connectClient(serve);
  try {
    return (await session.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, any>;
    };
  } finally {
    await session.close();
  }
}

const listedIds = async (serve: typeof admin) =>
  (await callTool(serve, "list_connections", {})).structuredContent?.connections.map(
    (connection: { id: string }) => connection.id,
  );

describe("the opt-in", () => {
  test("lists a seed with mcp: true, and neither one without it nor one with mcp: false", async () => {
    const database = join(dir, "shop.db");
    writeSeedFile(dir, [
      { id: "opted-in", type: "sqlite", database },
      { id: "silent", type: "sqlite", database, mcp: null },
      { id: "opted-out", type: "sqlite", database, mcp: false },
    ]);
    expect(await listedIds(admin)).toEqual(["seed:opted-in"]);
  });

  test.each(["inspect_schema", "run_read_query"])(
    "%s answers a seed that did not opt in exactly as a made-up id",
    async (tool) => {
      const database = join(dir, "shop.db");
      writeSeedFile(dir, [{ id: "silent", type: "sqlite", database, mcp: null }]);
      for (const connectionId of ["seed:silent", "seed:made-up"]) {
        const result = await callTool(admin, tool, { connection_id: connectionId, sql: "SELECT 1" });
        expect(result.content).toEqual([{ type: "text", text: MCP_NOT_VISIBLE_TEXT }]);
      }
    },
  );

  test("keeps the role filter: an admin-only seed is visible to an admin token and not to a user token", async () => {
    writeSeedFile(dir, [{ id: "admins", type: "sqlite", database: join(dir, "shop.db"), roles: ["admin"] }]);
    expect(await listedIds(admin)).toEqual(["seed:admins"]);
    expect(await listedIds(user)).toEqual([]);
  });

  test("never shows the built-in samples, even when both files exist", async () => {
    const sqliteSample = join(dir, "sample-employees.db");
    createSqliteFile(sqliteSample, ["CREATE TABLE employees (id INTEGER)"]);
    const libredbSample = join(dir, "sample.libredb");
    writeFileSync(libredbSample, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteSample;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbSample;
    writeSeedFile(dir, [{ id: "opted-in", type: "sqlite", database: join(dir, "shop.db") }]);
    expect(await listedIds(admin)).toEqual(["seed:opted-in"]);
    for (const connectionId of ["seed:sqlite-embedded-sample", "seed:libredb-embedded-sample"]) {
      const result = await callTool(admin, "inspect_schema", { connection_id: connectionId });
      expect(result.content).toEqual([{ type: "text", text: MCP_NOT_VISIBLE_TEXT }]);
    }
  });
});

describe("a seed file that cannot be loaded", () => {
  function brokenSeed(kind: "not-json" | "mcp-not-boolean"): void {
    const file = join(dir, "seed-connections.json");
    writeFileSync(
      file,
      kind === "not-json"
        ? "{ this is not json"
        : JSON.stringify({
            version: "1",
            connections: [
              { id: "shop", name: "Shop", type: "sqlite", database: join(dir, "shop.db"), roles: ["*"], mcp: "yes" },
            ],
          }),
    );
    process.env.SEED_CONFIG_PATH = file;
    resetCache();
  }

  test.each(["not-json", "mcp-not-boolean"] as const)(
    "answers every tool with the unreadable-configuration error (%s)",
    async (kind) => {
      brokenSeed(kind);
      const errorLog = spyOn(logger, "error").mockImplementation(() => {});
      try {
        for (const [tool, args] of [
          ["list_connections", {}],
          ["inspect_schema", { connection_id: "seed:shop" }],
          ["run_read_query", { connection_id: "seed:shop", sql: "SELECT 1" }],
        ] as const) {
          const result = await callTool(admin, tool, args);
          expect(result).toMatchObject({
            isError: true,
            content: [{ type: "text", text: MCP_CONNECTIONS_UNREADABLE_TEXT }],
          });
          expect(result.structuredContent).toBeUndefined();
        }
        const events = getServerAuditBuffer()
          .getAll()
          .filter((event) => event.type === "mcp_operation");
        expect(events.map((event) => [event.action, event.reason])).toEqual([
          ["list_connections", "mcp_connections_unreadable"],
          ["inspect_schema", "mcp_connections_unreadable"],
          ["run_read_query", "mcp_connections_unreadable"],
        ]);
        expect(errorLog).toHaveBeenCalled();
        expect(errorLog.mock.calls.every(([message]) => message === "Could not load managed connections for MCP")).toBe(
          true,
        );
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  test.each(["legacy", "pinned"] as const)(
    "leaves initialize, server/discover and tools/list working, because nothing reads the seed file until a tool asks (%s)",
    async (negotiation) => {
      // The legacy client connects with initialize, the pinned one with server/discover.
      brokenSeed("not-json");
      const session = await connectClient(admin, { negotiation });
      try {
        expect(session.client.getProtocolEra()).toBe(negotiation === "legacy" ? "legacy" : "modern");
        expect((await session.client.listTools()).tools).toHaveLength(3);
      } finally {
        await session.close();
      }
    },
  );

  test("never sends the file's path or the parser's words to the client", async () => {
    brokenSeed("not-json");
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const text = JSON.stringify(await callTool(admin, "list_connections", {}));
      expect(text).not.toContain(dir);
      expect(text).not.toContain("JSON");
    } finally {
      errorLog.mockRestore();
    }
  });
});
