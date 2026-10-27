/**
 * The one served-engine resolver (all-providers design 6, V12): an MCP statement tool serves an engine only when agent
 * mode executes statements on it, MCP_EXPOSABLE offers it, MCP_STATEMENT_READ opens it and its statement language is
 * the tool's. The records are passed in as well as read, so the case no shipped engine is in yet, an agent engine whose
 * MCP read row is still false, is pinned here rather than waiting for the first joiner.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { mcpStatementEngines, type McpExposure } from "@/lib/mcp/tools/served-engines";
import { RUN_READ_QUERY_TYPES } from "@/lib/mcp/tools/run-read-query";

const SHIPPED: McpExposure = {
  executes: AGENT_EXECUTION_ENGINES,
  exposable: MCP_EXPOSABLE,
  statementRead: MCP_STATEMENT_READ,
  language: AGENT_STATEMENT_LANGUAGE,
};

describe("mcpStatementEngines", () => {
  test("RUN_READ_QUERY_TYPES is exactly the SQL engines every exposure record lets through", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual(mcpStatementEngines("sql"));
    expect(RUN_READ_QUERY_TYPES).toEqual(
      AGENT_EXECUTION_ENGINES.filter(
        (type) => MCP_EXPOSABLE[type] && MCP_STATEMENT_READ[type] && AGENT_STATEMENT_LANGUAGE[type] === "sql",
      ),
    );
  });

  test("leaves RUN_READ_QUERY_TYPES as it was before MCP_STATEMENT_READ existed", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual(["postgres", "sqlite", "duckdb", "mssql", "mysql"]);
  });

  test("reads the shipped records when none are passed", () => {
    for (const language of ["sql", "mongo", "kubectl"] as const) {
      expect(mcpStatementEngines(language)).toEqual(mcpStatementEngines(language, SHIPPED));
    }
  });

  test("serves MongoDB in its own language, and no engine of a language MCP read has not opened", () => {
    // MongoDB opened with run_mongo_command (B117); Kubernetes executes for the agent and is not offered to MCP.
    expect(mcpStatementEngines("mongo")).toEqual(["mongodb"]);
    expect(mcpStatementEngines("kubectl")).toEqual([]);
  });

  test("an agent engine whose MCP read row is false is not served, though every other record lets it through", () => {
    const closed = { ...MCP_STATEMENT_READ, duckdb: false };
    expect(MCP_EXPOSABLE.duckdb).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).toContain("duckdb");
    expect(mcpStatementEngines("sql", { ...SHIPPED, statementRead: closed })).toEqual([
      "postgres",
      "sqlite",
      "mssql",
      "mysql",
    ]);
  });

  test("an engine MCP is not offered for is not served, whatever its MCP read row says", () => {
    const withheld = { ...MCP_EXPOSABLE, sqlite: false };
    expect(mcpStatementEngines("sql", { ...SHIPPED, exposable: withheld })).not.toContain("sqlite");
  });

  test("an engine agent mode does not execute on is not served, whatever its rows say", () => {
    const executes = AGENT_EXECUTION_ENGINES.filter((type) => type !== "mysql");
    expect(mcpStatementEngines("sql", { ...SHIPPED, executes })).not.toContain("mysql");
  });
});
