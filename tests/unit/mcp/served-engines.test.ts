/**
 * The one served-engine resolver: an MCP statement tool serves an engine only when its engine record grants agent
 * execution, `mcp.exposable` and `mcp.statementRead`, and its statement language is the tool's. A reader of the grants
 * is passed in as well as the engine record read, so the case no shipped engine is in yet, an agent engine whose MCP
 * read row is still false, is pinned here rather than waiting for the first joiner. The reader passed in answers the
 * register's legacy rows, so the oracle is the register, never the grant reader.
 */
import { describe, expect, test } from "bun:test";
import { parseGrantRegister } from "@libredb/grant-register";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import {
  beginServerCatalogBoot,
  forgetServerCatalog,
  installServerCatalog,
  servedEngines,
  serverCatalogInstalled,
} from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { mcpStatementEngines, type McpExposure } from "@/lib/mcp/tools/served-engines";
import { mcpToolInputSchemas } from "@/lib/mcp/tools";
import { registerStatementTools } from "@/lib/mcp/tools/run-statement";
import {
  type McpStatementArm,
  McpCompositionOrderError,
  mcpStatementSurface,
  mcpStatementToolFor,
} from "@/lib/mcp/tools/statement-arms";
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
  withEngineRecord,
  withLoosestClaims,
} from "../../helpers/package-catalog";

const agentExecution = legacyRegisterEngines("agentExecution");
const exposable = legacyRegisterTable("exposable");
const statementRead = legacyRegisterTable("statementRead");
const statementLanguage = legacyStatementLanguageTable();

type Exposed = ReturnType<McpExposure>;

/** The register's legacy rows of the four claims, read as a reader of an engine record's grants. */
const SHIPPED: McpExposure = (engine) => {
  const type = engine.id as string as DatabaseType;
  return {
    agentExecution: agentExecution.includes(type),
    exposable: exposable[type],
    statementRead: statementRead[type],
    statementLanguage: statementLanguage[type],
  };
};

/** `SHIPPED` with `member` of engine `target` read as `value`, every other engine and member as it is. */
const withRow =
  <M extends keyof Exposed>(member: M, target: DatabaseType, value: Exposed[M]): McpExposure =>
  (engine) =>
    engine.id === target ? { ...SHIPPED(engine), [member]: value } : SHIPPED(engine);

/** The engines `arm` serves, as text, or none where no arm is declared. */
const typesOf = (arm: McpStatementArm | null | undefined): readonly string[] => arm?.types ?? [];

/** The engines `language`'s tool serves, as text: the served records' ids, read through `exposure` where one is passed. */
const servedIds = (language: AgentStatementLanguageId, exposure?: McpExposure): readonly string[] =>
  exposure === undefined ? mcpStatementEngines(language) : mcpStatementEngines(language, servedEngines(), exposure);
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

const symmetricDifference = (a: readonly string[], b: readonly string[]): string[] => [
  ...a.filter((type) => !b.includes(type)),
  ...b.filter((type) => !a.includes(type)),
];

describe("mcpStatementEngines", () => {
  test("RUN_READ_QUERY_TYPES is exactly the SQL engines every exposure record lets through", () => {
    expect<readonly string[]>(RUN_READ_QUERY_TYPES).toEqual(servedIds("sql"));
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
        const before = servedIds(language);
        const after = servedIds(language, flipped);
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
      expect(servedIds(language)).toEqual(servedIds(language, SHIPPED));
    }
  });

  // The four records read directly, never through the resolver: an engine is served in its own language exactly when
  // agent mode executes on it, MCP is offered it and its MCP read row opens it.
  test("serves each engine in its own language, exactly where the four records allow it", () => {
    for (const type of SHIPPED_TYPES) {
      const language = statementLanguage[type];
      if (language === null) continue;
      expect(servedIds(language).includes(type)).toBe(servedByRecords(type));
    }
  });

  test("an agent engine whose MCP read row is false is not served, though every other record lets it through", () => {
    expect(exposable.duckdb).toBe(true);
    expect(agentExecution).toContain("duckdb");
    expect(servedIds("sql", withRow("statementRead", "duckdb", false))).toEqual(
      servedIds("sql").filter((type) => type !== "duckdb"),
    );
  });

  // InfluxDB 3's SQL shares a provider directory with InfluxDB's InfluxQL, and opening the first left the second shut.
  test("opening InfluxDB 3 leaves InfluxDB over InfluxQL unserved by every statement tool", () => {
    expect(statementRead.influxdb).toBe(false);
    expect(statementLanguage.influxdb).toBe("influxql");
    expect(servedIds("influxql")).toEqual([]);
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
    expect(servedIds("sql", withRow("statementRead", "opensearch", false))).toEqual(
      RUN_READ_QUERY_TYPES.filter((type) => type !== "opensearch"),
    );
  });

  test("an engine MCP is not offered for is not served, whatever its MCP read row says", () => {
    expect(servedIds("sql", withRow("exposable", "sqlite", false))).not.toContain("sqlite");
  });

  test("an engine agent mode does not execute on is not served, whatever its rows say", () => {
    expect(servedIds("sql", withRow("agentExecution", "mysql", false))).not.toContain("mysql");
  });

  test("the gate reads the engine record's grants: an engine whose record grants exposure is served, and one whose record does not is not", async () => {
    // Studio's grants, read with nothing installed: what each crafted grant below differs from.
    expect(servedIds("sql")).toContain("sqlite");
    expect(servedIds("sql")).toContain("duckdb");

    const catalog = craftedCatalog({ sqlite: { exposable: false }, duckdb: { statementRead: false } });
    await withCatalog(catalog, () => {
      const served = servedIds("sql");
      expect(served).not.toContain("sqlite");
      expect(served).not.toContain("duckdb");
      // Vacuity: an engine the crafted catalog leaves as it is is still served.
      expect(served).toContain("postgres");
    });
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("the served set is composed from the installed catalog, not at module load", async () => {
    // The MCP modules loaded above, with nothing installed: the bundled set.
    const bundled = mcpStatementSurface();
    expect(typesOf(bundled.arms.sql)).toContain("sqlite");
    expect(mcpStatementToolFor("sqlite")).toBe("run_read_query");
    expect(bundled.arms.sql?.description).toContain("SQLite");
    await withCatalog(craftedCatalog({ sqlite: { exposable: false } }), () => {
      const installed = mcpStatementSurface();
      expect(typesOf(installed.arms.sql)).not.toContain("sqlite");
      expect(mcpStatementToolFor("sqlite")).toBeNull();
      expect(installed.arms.sql?.description).not.toContain("SQLite");
      // Vacuity: an engine the crafted catalog leaves as it is is still served.
      expect(typesOf(installed.arms.sql)).toContain("postgres");
      expect(installed.arms.sql?.description).toContain("PostgreSQL");
      // One composition per installed catalog.
      expect(mcpStatementSurface()).toBe(installed);
    });
    // Forgotten, as a new process would: the bundled set again, the one composed before.
    expect(mcpStatementSurface()).toBe(bundled);
    expect(typesOf(mcpStatementSurface().arms.sql)).toContain("sqlite");
  });

  test("reading the served set before the catalog's install is a named host defect", () => {
    const server = { registerTool: () => {} } as unknown as McpServer;
    const reads: ReadonlyArray<readonly [string, () => unknown]> = [
      ["mcpStatementSurface", () => mcpStatementSurface()],
      ["mcpToolInputSchemas", () => mcpToolInputSchemas()],
      ["mcpStatementToolFor", () => mcpStatementToolFor("postgres")],
      ["registerStatementTools", () => registerStatementTools(server, {} as McpConnectionContext)],
    ];
    beginServerCatalogBoot();
    try {
      for (const [name, read] of reads) {
        let thrown: unknown;
        try {
          read();
        } catch (error) {
          thrown = error;
        }
        expect([name, thrown]).toEqual([name, expect.any(McpCompositionOrderError)]);
        expect((thrown as Error).name).toBe("McpCompositionOrderError");
        expect((thrown as Error).message).toBe(
          "MCP's statement tools were read while the server's engine catalog was still being composed at boot. Boot installs the catalog before the server serves any request, so this read is a defect of Studio's own composition order.",
        );
      }
      // The install ends the boot: each read answers.
      installServerCatalog(craftedCatalog({}));
      expect(typesOf(mcpStatementSurface().arms.sql)).toContain("postgres");
      expect(Object.keys(mcpToolInputSchemas())).toContain("run_read_query");
      expect(mcpStatementToolFor("postgres")).toBe("run_read_query");
      expect(registerStatementTools(server, {} as McpConnectionContext)).toBeUndefined();
    } finally {
      forgetServerCatalog();
    }
    // Nothing installed and no boot begun: the bundled set, no defect.
    expect(typesOf(mcpStatementSurface().arms.sql)).toContain("postgres");
  });

  test("the served set reads the record's execution profile offer, not its source", async () => {
    const catalog = withEngineRecord(craftedCatalog({}), "sqlite", (engine) => ({
      ...engine,
      offers: Object.freeze({ ...engine.offers, executionProfiles: false }),
    }));
    await withCatalog(catalog, () => {
      expect(servedEngines().get("sqlite")?.source.package).toBeNull();
      expect(servedIds("sql")).not.toContain("sqlite");
      expect(typesOf(mcpStatementSurface().arms.sql)).not.toContain("sqlite");
      expect(mcpStatementToolFor("sqlite")).toBeNull();
      // Vacuity: a legacy record that keeps the offer is served.
      expect(servedIds("sql")).toContain("postgres");
    });
  });

  test("a package engine a row grants every MCP statement claim is served by no statement tool while its record offers no execution profile", async () => {
    const pkg = admittedFor("acme-served", admittedManifest("acmeserved", withLoosestClaims));
    const register = parseGrantRegister(
      [
        packageRow(pkg, "acmeserved", {
          agentExecution: true,
          exposable: true,
          statementRead: true,
          statementLanguage: "sql",
          agentCredentialRequired: false,
          readRootsRequired: false,
        }),
      ],
      LEGACY_ENGINE_IDS,
    );
    const catalog = composeServerCatalog([pkg] as readonly AdmittedForCatalog[], [], register);
    await withCatalog(catalog, () => {
      // The premise: every grant the served set reads lets the engine through, and only the offer keeps it out.
      const engine = servedEngines().get("acmeserved");
      expect(engine?.grants).toMatchObject({
        agentExecution: true,
        exposable: true,
        statementRead: true,
        statementLanguage: "sql",
      });
      expect(engine?.offers.executionProfiles).toBe(false);
      for (const language of LANGUAGES) expect(servedIds(language)).not.toContain("acmeserved");
      for (const arm of Object.values(mcpStatementSurface().arms)) expect(typesOf(arm)).not.toContain("acmeserved");
      expect(mcpStatementToolFor("acmeserved" as DatabaseType)).toBeNull();
      // Vacuity: the installed catalog's legacy engines are served.
      expect(servedIds("sql")).toContain("postgres");
    });
    expect(serverCatalogInstalled()).toBe(false);
  });
});
