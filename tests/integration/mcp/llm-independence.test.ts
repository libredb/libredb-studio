/**
 * MCP needs no model (#2252, part 1): the client's model reads the answers, so Studio serves MCP with no LLM provider
 * configured and agent mode switched off.
 *
 * Every LLM_* variable is deleted and LIBREDB_AGENT_ENABLED is false. createLLMProvider and resolveConfig, the two
 * functions that turn LLM_* into a model, are replaced so that a call records itself and throws; every other export of
 * their modules is kept. process.env sits behind a proxy that records each read of an LLM_* or LIBREDB_AGENT_* name
 * and each enumeration of the environment while the route module is imported and while the route serves. A token
 * minted at run time then initializes, lists the tools and calls list_connections, inspect_schema and run_read_query
 * on an admin-only SQLite seed through the real POST handler.
 *
 * This held before the test existed, and the test keeps it: a read of LLM_PROVIDER placed on the MCP path fails it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realLlmFactory from "@/lib/llm/factory";
import * as realLlmConfig from "@/lib/llm/utils/config";

const modelCalls: string[] = [];

mock.module("@/lib/llm/factory", () => ({
  ...realLlmFactory,
  createLLMProvider: async () => {
    modelCalls.push("createLLMProvider");
    throw new Error("createLLMProvider was called on the MCP path");
  },
}));
mock.module("@/lib/llm/utils/config", () => ({
  ...realLlmConfig,
  resolveConfig: () => {
    modelCalls.push("resolveConfig");
    throw new Error("resolveConfig was called on the MCP path");
  },
}));

for (const name of Object.keys(process.env)) if (name.startsWith("LLM_")) delete process.env[name];
process.env.LIBREDB_AGENT_ENABLED = "false";

/** The model's settings and agent mode's: nothing on the MCP path reads either family. */
const WATCHED = /^(?:LLM_|LIBREDB_AGENT_)/;
const environmentUses: string[] = [];
let recording = false;
const realEnvironment = process.env;
process.env = new Proxy(realEnvironment, {
  get(target, key) {
    if (recording && typeof key === "string" && WATCHED.test(key)) environmentUses.push(`read ${key}`);
    return Reflect.get(target, key);
  },
  // Bun's process.env takes only a whole data descriptor, and an assignment through a proxy hands an existing key a
  // partial one, so every write goes to the real object itself.
  set(target, key, value) {
    return Reflect.set(target, key, value);
  },
  has(target, key) {
    if (recording && typeof key === "string" && WATCHED.test(key)) environmentUses.push(`asked for ${key}`);
    return Reflect.has(target, key);
  },
  ownKeys(target) {
    if (recording) environmentUses.push("enumerated the environment");
    return Reflect.ownKeys(target);
  },
});

/** Runs the work with the proxy recording, and answers what it recorded beside the work's own answer. */
async function recorded<T>(work: () => Promise<T>): Promise<{ readonly answer: T; readonly uses: readonly string[] }> {
  environmentUses.length = 0;
  recording = true;
  try {
    const answer = await work();
    return { answer, uses: [...environmentUses] };
  } finally {
    recording = false;
  }
}

const imported = await recorded(() => import("@/app/api/mcp/route"));
const route = imported.answer;
const { MCP_SERVER_NAME } = await import("@/lib/mcp/server");
const { createSqliteFile, pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } = await import(
  "../../helpers/mcp-fixtures"
);
const { legacyPost, readJsonRpc } = await import("../../helpers/mcp-harness");
const { mintTestToken, useMcpChannel } = await import("../../helpers/mcp-token");
const { registeredMcpToolNames } = await import("../../helpers/mcp-tool-names");

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-llm-independence-"));
createSqliteFile(join(dir, "shop.db"), [
  "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
  "INSERT INTO items VALUES (1, 'apple')",
]);

let restoreChannel: () => void = () => {};

beforeEach(() => {
  restoreChannel = useMcpChannel();
  modelCalls.length = 0;
  writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db") }]);
});

afterEach(async () => {
  restoreChannel();
  await resetMcpTestState();
});

afterAll(() => {
  process.env = realEnvironment;
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP with no LLM provider and agent mode off", () => {
  test("the environment holds no LLM_* variable, and agent mode is off", () => {
    expect(Object.keys(realEnvironment).filter((name) => name.startsWith("LLM_"))).toEqual([]);
    expect(realEnvironment.LIBREDB_AGENT_ENABLED).toBe("false");
  });

  test("the proxy records a read of a watched name and an enumeration, so an empty record means none happened", async () => {
    const { uses } = await recorded(async () => [process.env.LLM_PROVIDER, Object.keys(process.env).length]);
    expect(uses).toEqual(["read LLM_PROVIDER", "enumerated the environment"]);
  });

  test("importing the route reads no LLM_* or LIBREDB_AGENT_* variable and enumerates nothing", () => {
    expect(imported.uses).toEqual([]);
  });

  test("a minted token lists every tool and reads an admin-only SQLite seed, and nothing reads the model's settings", async () => {
    const token = await mintTestToken();
    let id = 0;
    const post = async (method: string, params?: Record<string, unknown>) =>
      readJsonRpc(
        await route.POST(
          legacyPost({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }, { token }),
        ),
      );
    const call = (name: string, args: Record<string, unknown>) => post("tools/call", { name, arguments: args });

    const { answer, uses } = await recorded(async () => ({
      initialized: await post("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "llm-independence", version: "1.0.0" },
      }),
      listed: await post("tools/list"),
      connections: await call("list_connections", {}),
      schema: await call("inspect_schema", { connection_id: "seed:shop" }),
      rows: await call("run_read_query", { connection_id: "seed:shop", sql: "SELECT id, name FROM items ORDER BY id" }),
    }));

    expect(answer.initialized.result?.serverInfo?.name).toBe(MCP_SERVER_NAME);
    expect(answer.listed.result?.tools.map((tool: { name: string }) => tool.name)).toEqual(registeredMcpToolNames());
    expect(answer.connections.result?.structuredContent).toMatchObject({
      connections: [{ id: "seed:shop", engine: "sqlite", read_tool: "run_read_query" }],
    });
    expect(answer.schema.result?.isError ?? false).toBe(false);
    expect(answer.schema.result?.structuredContent?.tables.map((table: { name: string }) => table.name)).toEqual([
      "items",
    ]);
    expect(answer.rows.result?.isError ?? false).toBe(false);
    expect(answer.rows.result?.structuredContent?.rows).toEqual([{ id: 1, name: "apple" }]);
    expect(uses).toEqual([]);
    expect(modelCalls).toEqual([]);
  });
});
