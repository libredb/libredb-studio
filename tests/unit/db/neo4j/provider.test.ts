/**
 * The Neo4j provider's own surface (Neo4j provider spec 6.1, 6.2, 7; revisions SR4, SR15, SR20): its engine
 * profile, every capability written out, the version read at connect, the health probe and the seven
 * monitoring reads, over the 5.26.31 captures through `recordedGraphClient`. The query path and the object
 * surface are the graph base's, pinned in tests/unit/db/graph/graph-base-provider.test.ts and end to end in
 * tests/integration/db/neo4j-provider.test.ts.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import {
  type BoltClientConfig,
  type GraphClient,
  GraphClientError,
  type GraphRunOptions,
  type GraphRunResult,
} from "@/lib/db/graph/bolt/client";
import { GRAPH_CONTAINER_LEVELS, GRAPH_OBJECT_KINDS } from "@/lib/db/graph/objects";
import { NEO4J_CATALOG_STATEMENTS, neo4jCatalog } from "@/lib/db/providers/graph/neo4j/catalog";
import { mapNeo4jError } from "@/lib/db/providers/graph/neo4j/errors";
import { NEO4J_ENGINE_PROFILE, Neo4jProvider } from "@/lib/db/providers/graph/neo4j/index";
import { neo4jLabels } from "@/lib/db/providers/graph/neo4j/labels";
import { NEO4J_MONITORING_STATEMENTS } from "@/lib/db/providers/graph/neo4j/monitoring-reads";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { neo4jStatementGate } from "@/lib/db/providers/graph/neo4j/statement-gate";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";
import { recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const NEO4J: DatabaseType = "neo4j";

const CONNECTION: DatabaseConnection = {
  id: "c1",
  name: "graph",
  type: NEO4J,
  host: "127.0.0.1",
  user: "neo4j",
  password: "secret",
  createdAt: new Date(0),
};

type Answer = GraphRunResult | Error;

/** A factory over the captures, with the given statements answered by the test; every client and run is kept. */
function capturedFactory(answers: Readonly<Record<string, Answer>> = {}) {
  const configs: BoltClientConfig[] = [];
  const calls: { statement: string; options: GraphRunOptions }[] = [];
  const factory = (config: BoltClientConfig): GraphClient => {
    configs.push(config);
    const recorded = recordedGraphClient();
    return {
      ...recorded,
      async run(statement, options) {
        calls.push({ statement, options });
        const answer = answers[statement];
        if (answer instanceof Error) throw answer;
        return answer ?? recorded.run(statement, options);
      },
    };
  };
  return { factory, configs, calls };
}

async function connected(answers: Readonly<Record<string, Answer>> = {}) {
  const transport = capturedFactory(answers);
  const provider = new Neo4jProvider(CONNECTION, {}, transport.factory);
  await provider.connect();
  return { provider, ...transport };
}

const components = (version: string): GraphRunResult => ({
  fields: ["name", "versions", "edition"],
  rows: [{ name: "Neo4j Kernel", versions: [version], edition: "enterprise" }],
  truncated: false,
});

describe("the engine profile", () => {
  test("is the policy profile with Neo4j's port, gate, catalog and error table, and no other hook (SR15)", () => {
    expect(NEO4J_ENGINE_PROFILE).toEqual({
      ...NEO4J_POLICY_PROFILE,
      defaultPort: 7687,
      statementGate: neo4jStatementGate,
      catalog: neo4jCatalog,
      mapError: mapNeo4jError,
    });
  });

  test("a connection with no port dials 7687", async () => {
    const { configs } = await connected();
    expect(configs[0]?.uri).toBe("bolt://127.0.0.1:7687");
  });

  test("the options argument is optional", () => {
    expect(new Neo4jProvider(CONNECTION).getLabels()).toEqual(neo4jLabels());
  });
});

describe("getCapabilities", () => {
  test("every capability is written out (spec 6.2, SR20)", () => {
    expect(new Neo4jProvider(CONNECTION).getCapabilities()).toEqual({
      queryLanguage: "cypher",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 7687,
      statementTerminator: "none",
      containerLevels: GRAPH_CONTAINER_LEVELS,
      objectKinds: GRAPH_OBJECT_KINDS,
      schemaRefreshPattern: "(?!)",
    } as unknown as ReturnType<Neo4jProvider["getCapabilities"]>);
  });

  test("no flag is left to the base class's SQL defaults", () => {
    const provider = new Neo4jProvider(CONNECTION);
    const defaults = BaseDatabaseProvider.prototype.getCapabilities.call(provider);
    const declared = provider.getCapabilities();
    for (const key of Object.keys(defaults)) expect(Object.hasOwn(declared, key)).toBe(true);
  });

  test("the schema refresh pattern matches no statement", () => {
    const pattern = new RegExp(new Neo4jProvider(CONNECTION).getCapabilities().schemaRefreshPattern);
    for (const text of ["CREATE (n)", "DROP INDEX x", "MATCH (n) RETURN n", ""]) expect(pattern.test(text)).toBe(false);
  });
});

describe("connect", () => {
  // The production path: no factory injected, so the Bolt transport the composition root builds runs. A
  // userinfo host is refused by boltEndpointOf before any socket opens, which only the real transport says.
  test("without an injected factory, builds the Bolt endpoint and refuses a userinfo host before any socket", async () => {
    const provider = new Neo4jProvider({ ...CONNECTION, host: "user@neo4j.internal" });
    await expect(provider.connect()).rejects.toThrow(/user/i);
    expect(provider.isConnected()).toBe(false);
  });

  test("reads the kernel's version once, on the connection's database", async () => {
    const { provider, calls } = await connected();
    const reads = calls.filter((call) => call.statement === NEO4J_MONITORING_STATEMENTS.components);
    expect(reads.map((call) => call.options.database)).toEqual(["neo4j"]);
    expect((await provider.getOverview()).version).toBe("5.26.31 community");
  });

  test("a server outside 5.26 connects and is reported untested", async () => {
    const { provider } = await connected({ [NEO4J_MONITORING_STATEMENTS.components]: components("5.27.0") });
    expect(provider.isConnected()).toBe(true);
    expect((await provider.getOverview()).version).toBe("5.27.0 enterprise (untested)");
  });

  test("a failed version read does not fail the connection; the version is then unknown", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = new GraphClientError("access-mode", "Permission denied", "Neo.ClientError.Security.Forbidden");
      const { provider } = await connected({ [NEO4J_MONITORING_STATEMENTS.components]: refused });
      expect(provider.isConnected()).toBe(true);
      expect((await provider.getOverview()).version).toBe("unknown");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a configured database the server does not hold fails the connect, and the client is closed", async () => {
    const missing = new GraphClientError("query", "Graph not found: nope", "Neo.ClientError.Database.DatabaseNotFound");
    const transport = capturedFactory({ [NEO4J_MONITORING_STATEMENTS.components]: missing });
    let closed = 0;
    const factory = (config: BoltClientConfig): GraphClient => {
      const client = transport.factory(config);
      return {
        ...client,
        async close() {
          closed += 1;
          await client.close();
        },
      };
    };
    const provider = new Neo4jProvider({ ...CONNECTION, database: "nope" }, {}, factory);
    const failure = await provider.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as QueryError).message).toBe("Graph not found: nope");
    expect(provider.isConnected()).toBe(false);
    expect(closed).toBe(1);
    expect(transport.calls.map((call) => call.options.database)).toEqual(["nope"]);
  });

  test("a reconnect reads the version again", async () => {
    const { provider, calls } = await connected();
    await provider.connect();
    expect(calls.filter((call) => call.statement === NEO4J_MONITORING_STATEMENTS.components).length).toBe(2);
  });
});

describe("getHealth", () => {
  test("verifies, then pings the database", async () => {
    const { provider, calls } = await connected();
    const before = calls.length;
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(calls.slice(before).map((call) => [call.statement, call.options.database])).toEqual([
      [NEO4J_MONITORING_STATEMENTS.ping, "neo4j"],
    ]);
  });

  test("a ping that fails is the mapped error", async () => {
    const { provider } = await connected({
      [NEO4J_MONITORING_STATEMENTS.ping]: new GraphClientError("connection", "Connection refused"),
    });
    await expect(provider.getHealth()).rejects.toThrow(ConnectionError);
  });
});

describe("the monitoring reads", () => {
  test("answer from the captures", async () => {
    const { provider } = await connected();
    expect(await provider.getOverview()).toMatchObject({ tableCount: 7, indexCount: 2 });
    expect((await provider.getActiveSessions()).map((session) => session.pid)).toEqual(["neo4j-transaction-18"]);
    expect((await provider.getTableStats()).map((row) => row.tableName)).toHaveLength(7);
    expect((await provider.getIndexStats()).map((row) => row.indexName)).toEqual(["person_name", "service_id"]);
  });

  test("table stats log the labels no Cypher name can spell, which they leave out", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { provider } = await connected({
        [NEO4J_CATALOG_STATEMENTS.label]: {
          fields: ["label"],
          rows: [{ label: "A\u0001bad" }, { label: "Person" }],
          truncated: false,
        },
      });
      expect((await provider.getTableStats()).map((row) => row.tableName)).toEqual(["Person"]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toBe(
        '[DB:neo4j] table stats failed: 1 label no Cypher name can spell was left out: "A\\u0001bad"',
      );
    } finally {
      logged.mockRestore();
    }
  });

  test("slow queries, storage and performance have nothing to report", async () => {
    const { provider } = await connected();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expect(await provider.getPerformanceMetrics()).toEqual({});
  });

  test("a refused read is the panel's empty answer", async () => {
    const refused = new GraphClientError("access-mode", "Permission denied", "Neo.ClientError.Security.Forbidden");
    const { provider } = await connected({ [NEO4J_MONITORING_STATEMENTS.transactions]: refused });
    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("a server that cannot be reached is the mapped error, and a defect is itself", async () => {
    const unreachable = new GraphClientError("connection", "Connection refused");
    const { provider } = await connected({ [NEO4J_MONITORING_STATEMENTS.indexUsage]: unreachable });
    await expect(provider.getIndexStats()).rejects.toThrow(ConnectionError);
    const defect = new Error("boom");
    const other = await connected({ [NEO4J_MONITORING_STATEMENTS.indexUsage]: defect });
    await expect(other.provider.getIndexStats()).rejects.toBe(defect);
  });

  test("every read refuses a provider that is not connected", async () => {
    const provider = new Neo4jProvider(CONNECTION, {}, capturedFactory().factory);
    const reads: Promise<unknown>[] = [
      provider.getOverview(),
      provider.getActiveSessions(),
      provider.getTableStats(),
      provider.getIndexStats(),
      provider.getSlowQueries(),
      provider.getStorageStats(),
      provider.getPerformanceMetrics(),
    ];
    const outcomes = await Promise.allSettled(reads);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(reads.length).fill("rejected"));
  });
});
