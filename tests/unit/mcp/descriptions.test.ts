/**
 * What an MCP client reads before it calls anything (#246): the tool descriptions, which a
 * client may cut at 2,048 characters, so each says first what the tool does; the instructions,
 * at most 512 characters, which carry only server-wide facts; and the engine sentence, derived
 * from the one engine list rather than written out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { getDBConfig } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { INSPECT_SCHEMA_DESCRIPTION } from "@/lib/mcp/tools/inspect-schema";
import { LIST_CONNECTIONS_DESCRIPTION } from "@/lib/mcp/tools/list-connections";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import { RUN_READ_QUERY_DESCRIPTION, RUN_READ_QUERY_ENGINES, RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import { handlerServe, legacyPost, readJsonRpc } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const RUN_KUBECTL_READ_ARM = mcpStatementArm("run_kubectl_read");
const RUN_MONGO_COMMAND_ARM = mcpStatementArm("run_mongo_command");

afterEach(async () => {
  await resetMcpTestState();
});

const DESCRIPTIONS = [
  ["list_connections", LIST_CONNECTIONS_DESCRIPTION, "List the database connections"],
  ["inspect_schema", INSPECT_SCHEMA_DESCRIPTION, "List the tables of one connection"],
  ["run_read_query", RUN_READ_QUERY_DESCRIPTION, "Run one read-only SQL statement"],
  ["run_kubectl_read", RUN_KUBECTL_READ_ARM.description, "Run one read-only kubectl read"],
  ["run_mongo_command", RUN_MONGO_COMMAND_ARM.description, "Run one read-only MongoDB command"],
] as const;

describe("the tool descriptions", () => {
  test.each(DESCRIPTIONS)("%s fits 2,048 characters and says first what it does", (_name, description, opening) => {
    expect(description.length).toBeLessThanOrEqual(2_048);
    expect(description.startsWith(opening)).toBe(true);
  });

  test("the tools that quote database content end with the notice, and list_connections carries none", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(RUN_READ_QUERY_DESCRIPTION.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(RUN_MONGO_COMMAND_ARM.description.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(RUN_KUBECTL_READ_ARM.description.endsWith(MCP_UNTRUSTED_NOTICE)).toBe(true);
    expect(LIST_CONNECTIONS_DESCRIPTION).not.toContain(MCP_UNTRUSTED_NOTICE);
  });

  test("run_read_query names the engines it serves, from the one list its handler gates on", () => {
    expect(RUN_READ_QUERY_ENGINES).toBe(namedList(RUN_READ_QUERY_TYPES.map((type) => getDBConfig(type).label)));
    expect(RUN_READ_QUERY_ENGINES).toBe(
      "PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, ClickHouse, libSQL, InfluxDB 3 (SQL) and Elasticsearch",
    );
    expect(RUN_READ_QUERY_DESCRIPTION).toContain(
      `Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.`,
    );
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("use inspect_schema there");
  });

  // The engines left out are derived from the records rather than listed, so an engine that later opens MCP read, or
  // joins agent mode with its MCP read row false, moves between these sets without editing this file.
  test("an execution engine the records keep out of this tool is neither served nor named", () => {
    const withheld = AGENT_EXECUTION_ENGINES.filter(
      (candidate) =>
        !MCP_EXPOSABLE[candidate] || !MCP_STATEMENT_READ[candidate] || AGENT_STATEMENT_LANGUAGE[candidate] !== "sql",
    );
    // Not vacuous while any execution engine is kept out; today Kubernetes and MongoDB are.
    expect(withheld.length).toBeGreaterThan(0);
    for (const type of withheld) {
      expect(RUN_READ_QUERY_TYPES).not.toContain(type);
      expect(RUN_READ_QUERY_ENGINES).not.toContain(getDBConfig(type).label);
    }
  });

  test("run_mongo_command names MongoDB, the one engine its handler gates on, and says it takes no offset", () => {
    expect(RUN_MONGO_COMMAND_ARM.description).toContain("Runs on MongoDB; other engines refuse it.");
    expect(RUN_MONGO_COMMAND_ARM.description).toContain("this tool takes no offset");
  });

  test("run_kubectl_read names Kubernetes, the one engine its handler gates on, and says what it masks", () => {
    expect(RUN_KUBECTL_READ_ARM.description).toContain("Runs on Kubernetes; other engines refuse it.");
    expect(RUN_KUBECTL_READ_ARM.description).toContain("a Secret's name in every field defined to hold one");
    expect(RUN_KUBECTL_READ_ARM.description).not.toContain("wherever it appears");
    expect(RUN_KUBECTL_READ_ARM.description).toContain(
      "Free-text status, event and log messages are not masked, so a Secret's name or a value an application printed can reach you there.",
    );
    expect(RUN_KUBECTL_READ_ARM.description).toContain("this tool takes no offset");
  });

  test("inspect_schema says an engine with no tables refuses it, and where to read it instead", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain(
      "Works on every engine that holds tables. An engine whose objects are not tables refuses it, and the refusal names the tool that reads it, as list_connections' read_tool does.",
    );
    expect(INSPECT_SCHEMA_DESCRIPTION).not.toContain("Works on every engine.");
    // Shared copy names no engine: the refusal names the engine's own tool.
    expect(INSPECT_SCHEMA_DESCRIPTION).not.toContain("Kubernetes");
  });

  test("names no statement form, because the forms differ by engine and the refusal names them", () => {
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("VALUES");
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("TABLE");
    expect(RUN_READ_QUERY_DESCRIPTION).toContain(
      "A SELECT runs on every engine it serves; a refused statement's answer names what else that engine takes.",
    );
    // Elasticsearch parses a WITH and reads a name it defines as an index, so no WITH is promised for every engine.
    expect(RUN_READ_QUERY_DESCRIPTION).not.toContain("WITH");
  });

  test("list_connections says it works on every engine, and inspect_schema on every engine that holds tables", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain("Works on every engine that holds tables.");
    expect(LIST_CONNECTIONS_DESCRIPTION).toContain("Works for every engine.");
  });

  test("inspect_schema says, in static words, that sampled columns are left out", () => {
    expect(INSPECT_SCHEMA_DESCRIPTION).toContain(
      "Columns an engine only inferred from sampled data are left out, so a table may hold fields this list does not show.",
    );
  });
});

describe("the instructions", () => {
  test("fit 512 characters and carry neither the notice nor a read-only claim", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(MCP_INSTRUCTIONS).not.toContain(MCP_UNTRUSTED_NOTICE);
    expect(MCP_INSTRUCTIONS.toLowerCase()).not.toContain("read-only");
  });

  test("send a statement to the tool a connection's read_tool names, not to one tool for every engine", () => {
    expect(MCP_INSTRUCTIONS).toContain("then run a read with the tool its read_tool names");
    expect(MCP_INSTRUCTIONS).not.toContain("run SQL with run_read_query");
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
