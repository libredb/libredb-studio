/**
 * What an MCP client reads before it calls anything (#246): the three tool descriptions, which a
 * client may cut at 2,048 characters, so each says first what the tool does; the instructions,
 * at most 512 characters, which carry only server-wide facts; and the engine sentence, derived
 * from the one engine list rather than written out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { getDBConfig } from "@/lib/db-ui-config";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { INSPECT_SCHEMA_DESCRIPTION } from "@/lib/mcp/tools/inspect-schema";
import { LIST_CONNECTIONS_DESCRIPTION } from "@/lib/mcp/tools/list-connections";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_ENGINES } from "@/lib/mcp/tools/run-read-query";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import { handlerServe, legacyPost, readJsonRpc } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

afterEach(async () => {
  await resetMcpTestState();
});

const DESCRIPTIONS = [
  ["list_connections", LIST_CONNECTIONS_DESCRIPTION, "List the database connections"],
  ["inspect_schema", INSPECT_SCHEMA_DESCRIPTION, "List the tables of one connection"],
  ["run_read_query", RUN_READ_QUERY_DESCRIPTION, "Run one read-only SQL statement"],
] as const;

describe("the tool descriptions", () => {
  test.each(DESCRIPTIONS)("%s fits 2,048 characters and says first what it does", (_name, description, opening) => {
    expect(description.length).toBeLessThanOrEqual(2_048);
    expect(description.startsWith(opening)).toBe(true);
  });

  test("the two tools that quote database content end with the notice, and list_connections carries none", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(RUN_READ_QUERY_DESCRIPTION.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(LIST_CONNECTIONS_DESCRIPTION).not.toContain(MCP_UNTRUSTED_NOTICE);
  });

  test("run_read_query names the engines derived from the one engine list", () => {
    const derived = namedList(AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label));
    expect(RUN_READ_QUERY_ENGINES).toBe(derived);
    expect(derived).toBe("PostgreSQL, SQLite, DuckDB and SQL Server");
    expect(RUN_READ_QUERY_DESCRIPTION).toContain(
      `Runs on ${derived}; other engines refuse it, so use inspect_schema there.`,
    );
  });

  test("inspect_schema and list_connections say they work on every engine", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain("Works on every engine.");
    expect(LIST_CONNECTIONS_DESCRIPTION).toContain("Works for every engine.");
  });
});

describe("the instructions", () => {
  test("fit 512 characters and carry neither the notice nor a read-only claim", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(MCP_INSTRUCTIONS).not.toContain(MCP_UNTRUSTED_NOTICE);
    expect(MCP_INSTRUCTIONS.toLowerCase()).not.toContain("read-only");
  });

  test("reach a legacy client in the InitializeResult", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "descriptions-test", version: "1.0.0" },
      },
    };
    const result = (await readJsonRpc(await handlerServe()(legacyPost(initialize, { version: null })))).result;
    expect(result?.instructions).toBe(MCP_INSTRUCTIONS);
  });
});
