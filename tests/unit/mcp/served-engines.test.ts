/**
 * The one served-engine resolver: an MCP statement tool serves an engine only when agent
 * mode executes statements on it, the grant of `mcp.exposable` offers it, the grant of `mcp.statementRead` opens it and
 * its statement language is the tool's. The records are passed in as well as read, so the case no shipped engine is in yet, an agent engine whose
 * MCP read row is still false, is pinned here rather than waiting for the first joiner.
 */
import { describe, expect, test } from "bun:test";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES, AGENT_STATEMENT_LANGUAGE } from "@/lib/db/compatibility";
import { mcpStatementEngines, type McpExposure } from "@/lib/mcp/tools/served-engines";
import type { DatabaseType } from "@/lib/types";
import { RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const exposable = legacyRegisterTable("exposable");
const statementRead = legacyRegisterTable("statementRead");

const SHIPPED: McpExposure = {
  executes: AGENT_EXECUTION_ENGINES,
  exposable: exposable,
  statementRead: statementRead,
  language: AGENT_STATEMENT_LANGUAGE,
};
const SHIPPED_TYPES = Object.keys(statementRead) as DatabaseType[];
const LANGUAGES = [...new Set(Object.values(AGENT_STATEMENT_LANGUAGE))].filter(
  (language): language is AgentStatementLanguageId => language !== null,
);

/** The four records, each read on its own: what the resolver must agree with. */
const servedByRecords = (type: DatabaseType): boolean =>
  AGENT_EXECUTION_ENGINES.includes(type) &&
  exposable[type] &&
  statementRead[type] &&
  AGENT_STATEMENT_LANGUAGE[type] !== null;

/** A closed engine a flip of its MCP read row alone would open. */
const opensWhenFlipped = (type: DatabaseType): boolean =>
  !statementRead[type] && AGENT_EXECUTION_ENGINES.includes(type) && exposable[type];

const symmetricDifference = (a: readonly DatabaseType[], b: readonly DatabaseType[]): DatabaseType[] => [
  ...a.filter((type) => !b.includes(type)),
  ...b.filter((type) => !a.includes(type)),
];

describe("mcpStatementEngines", () => {
  test("RUN_READ_QUERY_TYPES is exactly the SQL engines every exposure record lets through", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual(mcpStatementEngines("sql"));
    expect(RUN_READ_QUERY_TYPES).toEqual(
      AGENT_EXECUTION_ENGINES.filter(
        (type) => exposable[type] && statementRead[type] && AGENT_STATEMENT_LANGUAGE[type] === "sql",
      ),
    );
  });

  // A row that opens one engine moves no other: flipping one engine's MCP statement read row, in a copy of the
  // shipped records, changes that engine's language's served set alone, and only by that engine.
  test.each(SHIPPED_TYPES.filter((type) => AGENT_STATEMENT_LANGUAGE[type] !== null))(
    "flipping %s's MCP read row moves only its own language's served set, and only by it",
    (type) => {
      const flipped = { ...SHIPPED, statementRead: { ...statementRead, [type]: !statementRead[type] } };
      const own = AGENT_STATEMENT_LANGUAGE[type];
      for (const language of LANGUAGES) {
        const before = mcpStatementEngines(language);
        const after = mcpStatementEngines(language, flipped);
        if (language !== own) expect(after).toEqual(before);
        else
          expect(symmetricDifference(before, after)).toEqual(
            servedByRecords(type) || opensWhenFlipped(type) ? [type] : [],
          );
      }
    },
  );

  test("reads the shipped records when none are passed", () => {
    for (const language of LANGUAGES) {
      expect(mcpStatementEngines(language)).toEqual(mcpStatementEngines(language, SHIPPED));
    }
  });

  // The four records read directly, never through the resolver: an engine is served in its own language exactly when
  // agent mode executes on it, MCP is offered it and its MCP read row opens it.
  test("serves each engine in its own language, exactly where the four records allow it", () => {
    for (const type of SHIPPED_TYPES) {
      const language = AGENT_STATEMENT_LANGUAGE[type];
      if (language === null) continue;
      expect(mcpStatementEngines(language).includes(type)).toBe(servedByRecords(type));
    }
  });

  test("an agent engine whose MCP read row is false is not served, though every other record lets it through", () => {
    const closed = { ...statementRead, duckdb: false };
    expect(exposable.duckdb).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).toContain("duckdb");
    expect(mcpStatementEngines("sql", { ...SHIPPED, statementRead: closed })).toEqual(
      mcpStatementEngines("sql").filter((type) => type !== "duckdb"),
    );
  });

  // InfluxDB 3's SQL shares a provider directory with InfluxDB's InfluxQL, and opening the first left the second shut.
  test("opening InfluxDB 3 leaves InfluxDB over InfluxQL unserved by every statement tool", () => {
    expect(statementRead.influxdb).toBe(false);
    expect(AGENT_STATEMENT_LANGUAGE.influxdb).toBe("influxql");
    expect(mcpStatementEngines("influxql")).toEqual([]);
    expect(RUN_READ_QUERY_TYPES).not.toContain("influxdb");
  });

  // One provider directory serves Elasticsearch and OpenSearch, and each opened by a row of its own: the two rows are
  // separate, so opening OpenSearch moved Elasticsearch's membership nowhere.
  test("OpenSearch is served by run_read_query alone, through its own row, beside Elasticsearch's", () => {
    expect(statementRead.opensearch).toBe(true);
    expect(exposable.opensearch).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).toContain("opensearch");
    expect(AGENT_STATEMENT_LANGUAGE.opensearch).toBe("sql");
    expect(RUN_READ_QUERY_TYPES).toContain("opensearch");
    expect(RUN_READ_QUERY_TYPES).toContain("elasticsearch");
    expect(mcpStatementEngines("sql", { ...SHIPPED, statementRead: { ...statementRead, opensearch: false } })).toEqual(
      RUN_READ_QUERY_TYPES.filter((type) => type !== "opensearch"),
    );
  });

  test("an engine MCP is not offered for is not served, whatever its MCP read row says", () => {
    const withheld = { ...exposable, sqlite: false };
    expect(mcpStatementEngines("sql", { ...SHIPPED, exposable: withheld })).not.toContain("sqlite");
  });

  test("an engine agent mode does not execute on is not served, whatever its rows say", () => {
    const executes = AGENT_EXECUTION_ENGINES.filter((type) => type !== "mysql");
    expect(mcpStatementEngines("sql", { ...SHIPPED, executes })).not.toContain("mysql");
  });
});
