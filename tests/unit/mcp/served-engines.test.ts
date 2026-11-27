/**
 * The one served-engine resolver: an MCP statement tool serves an engine only when its engine record grants agent
 * execution, `mcp.exposable` and `mcp.statementRead`, and its statement language is the tool's. A reader of the grants
 * is passed in as well as the engine record read, so the case no shipped engine is in yet, an agent engine whose MCP
 * read row is still false, is pinned here rather than waiting for the first joiner. The reader passed in answers the
 * register's legacy rows, so the oracle is the register, never the grant reader.
 */
import { describe, expect, test } from "bun:test";
import { parseGrantRegister } from "@libredb/grant-register";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { serverCatalogInstalled } from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { mcpStatementEngines, type McpExposure } from "@/lib/mcp/tools/served-engines";
import { MCP_STATEMENT_ARMS, mcpStatementToolFor } from "@/lib/mcp/tools/statement-arms";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { DatabaseType } from "@/lib/types";
import { RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";
import {
  legacyRegisterEngines,
  legacyRegisterTable,
  legacyStatementLanguageTable,
} from "../../helpers/legacy-register";
import {
  admittedFor,
  admittedManifest,
  craftedCatalog,
  packageRow,
  withCatalog,
  withLoosestClaims,
} from "../../helpers/package-catalog";

const agentExecution = legacyRegisterEngines("agentExecution");
const exposable = legacyRegisterTable("exposable");
const statementRead = legacyRegisterTable("statementRead");
const statementLanguage = legacyStatementLanguageTable();

type Exposed = ReturnType<McpExposure>;

/** The register's legacy rows of the four claims, read as a reader of the grants. */
const SHIPPED: McpExposure = (type) => ({
  agentExecution: agentExecution.includes(type),
  exposable: exposable[type],
  statementRead: statementRead[type],
  statementLanguage: statementLanguage[type],
});

/** `SHIPPED` with `member` of engine `engine` read as `value`, every other engine and member as it is. */
const withRow =
  <M extends keyof Exposed>(member: M, engine: DatabaseType, value: Exposed[M]): McpExposure =>
  (type) =>
    type === engine ? { ...SHIPPED(type), [member]: value } : SHIPPED(type);
const SHIPPED_TYPES = Object.keys(statementRead) as DatabaseType[];
const LANGUAGES = [...new Set(Object.values(statementLanguage))].filter(
  (language): language is AgentStatementLanguageId => language !== null,
);

/** The four records, each read on its own: what the resolver must agree with. */
const servedByRecords = (type: DatabaseType): boolean =>
  agentExecution.includes(type) && exposable[type] && statementRead[type] && statementLanguage[type] !== null;

/** A closed engine a flip of its MCP read row alone would open. */
const opensWhenFlipped = (type: DatabaseType): boolean =>
  !statementRead[type] && agentExecution.includes(type) && exposable[type];

const symmetricDifference = (a: readonly DatabaseType[], b: readonly DatabaseType[]): DatabaseType[] => [
  ...a.filter((type) => !b.includes(type)),
  ...b.filter((type) => !a.includes(type)),
];

describe("mcpStatementEngines", () => {
  test("RUN_READ_QUERY_TYPES is exactly the SQL engines every exposure record lets through", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual(mcpStatementEngines("sql"));
    expect(RUN_READ_QUERY_TYPES).toEqual(
      agentExecution.filter((type) => exposable[type] && statementRead[type] && statementLanguage[type] === "sql"),
    );
  });

  // A row that opens one engine moves no other: flipping one engine's MCP statement read row, in a copy of the
  // shipped records, changes that engine's language's served set alone, and only by that engine.
  test.each(SHIPPED_TYPES.filter((type) => statementLanguage[type] !== null))(
    "flipping %s's MCP read row moves only its own language's served set, and only by it",
    (type) => {
      const flipped = withRow("statementRead", type, !statementRead[type]);
      const own = statementLanguage[type];
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

  test("reads the engine records when no reader is passed", () => {
    for (const language of LANGUAGES) {
      expect(mcpStatementEngines(language)).toEqual(mcpStatementEngines(language, SHIPPED));
    }
  });

  // The four records read directly, never through the resolver: an engine is served in its own language exactly when
  // agent mode executes on it, MCP is offered it and its MCP read row opens it.
  test("serves each engine in its own language, exactly where the four records allow it", () => {
    for (const type of SHIPPED_TYPES) {
      const language = statementLanguage[type];
      if (language === null) continue;
      expect(mcpStatementEngines(language).includes(type)).toBe(servedByRecords(type));
    }
  });

  test("an agent engine whose MCP read row is false is not served, though every other record lets it through", () => {
    expect(exposable.duckdb).toBe(true);
    expect(agentExecution).toContain("duckdb");
    expect(mcpStatementEngines("sql", withRow("statementRead", "duckdb", false))).toEqual(
      mcpStatementEngines("sql").filter((type) => type !== "duckdb"),
    );
  });

  // InfluxDB 3's SQL shares a provider directory with InfluxDB's InfluxQL, and opening the first left the second shut.
  test("opening InfluxDB 3 leaves InfluxDB over InfluxQL unserved by every statement tool", () => {
    expect(statementRead.influxdb).toBe(false);
    expect(statementLanguage.influxdb).toBe("influxql");
    expect(mcpStatementEngines("influxql")).toEqual([]);
    expect(RUN_READ_QUERY_TYPES).not.toContain("influxdb");
  });

  // One provider directory serves Elasticsearch and OpenSearch, and each opened by a row of its own: the two rows are
  // separate, so opening OpenSearch moved Elasticsearch's membership nowhere.
  test("OpenSearch is served by run_read_query alone, through its own row, beside Elasticsearch's", () => {
    expect(statementRead.opensearch).toBe(true);
    expect(exposable.opensearch).toBe(true);
    expect(agentExecution).toContain("opensearch");
    expect(statementLanguage.opensearch).toBe("sql");
    expect(RUN_READ_QUERY_TYPES).toContain("opensearch");
    expect(RUN_READ_QUERY_TYPES).toContain("elasticsearch");
    expect(mcpStatementEngines("sql", withRow("statementRead", "opensearch", false))).toEqual(
      RUN_READ_QUERY_TYPES.filter((type) => type !== "opensearch"),
    );
  });

  test("an engine MCP is not offered for is not served, whatever its MCP read row says", () => {
    expect(mcpStatementEngines("sql", withRow("exposable", "sqlite", false))).not.toContain("sqlite");
  });

  test("an engine agent mode does not execute on is not served, whatever its rows say", () => {
    expect(mcpStatementEngines("sql", withRow("agentExecution", "mysql", false))).not.toContain("mysql");
  });

  test("the gate reads the engine record's grants: an engine whose record grants exposure is served, and one whose record does not is not", async () => {
    // Studio's grants, read with nothing installed: what each crafted grant below differs from.
    expect(mcpStatementEngines("sql")).toContain("sqlite");
    expect(mcpStatementEngines("sql")).toContain("duckdb");

    const catalog = craftedCatalog({ sqlite: { exposable: false }, duckdb: { statementRead: false } });
    await withCatalog(catalog, () => {
      const served = mcpStatementEngines("sql");
      expect(served).not.toContain("sqlite");
      expect(served).not.toContain("duckdb");
      // Vacuity: an engine the crafted catalog leaves as it is is still served.
      expect(served).toContain("postgres");
    });
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("a package engine whose register row grants every MCP statement claim is served by no statement tool until MCP opens to package engines", async () => {
    const pkg = admittedFor("acme-served", admittedManifest("acmeserved", withLoosestClaims));
    const register = parseGrantRegister(
      [
        packageRow(pkg, "acmeserved", {
          agentExecution: true,
          exposable: true,
          statementRead: true,
          statementLanguage: "sql",
        }),
      ],
      LEGACY_ENGINE_IDS,
    );
    const catalog = composeServerCatalog([pkg] as readonly AdmittedForCatalog[], [], register);
    await withCatalog(catalog, () => {
      for (const language of LANGUAGES) expect(mcpStatementEngines(language)).not.toContain("acmeserved");
      expect(MCP_STATEMENT_ARMS.sql?.types).not.toContain("acmeserved");
      expect(mcpStatementToolFor("acmeserved" as DatabaseType)).toBeNull();
    });
    expect(serverCatalogInstalled()).toBe(false);
  });
});
