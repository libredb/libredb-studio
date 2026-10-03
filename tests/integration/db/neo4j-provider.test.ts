/**
 * Neo4j provider, end to end (Neo4j provider spec 10; revisions SR4, SR10, SR11, SR16).
 *
 * The real provider, graph base, read policy, statement gate, catalog, monitoring reads and error table all
 * run; only the server is fake. The fake is `recordedGraphClient` of `tests/helpers/neo4j-fixtures.ts`, handed
 * to the provider through its client factory, which answers each run from what the server answered live to the
 * exact statement text and database, and fails on any other. `mock.module()` is not used: it is process-wide in
 * bun and would poison sibling test files.
 *
 * The answers were captured by `tests/live/neo4j-evidence.ts` on 2026-10-03 from `neo4j:5.26.31-community`
 * (`sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255`), seeded from
 * `docker/neo4j/seed.cypher`; `tests/fixtures/neo4j/5.26.31/README.md` lists them.
 *
 * What is BUILT from a capture rather than read from one, each said again where it is built:
 * - The statement gate's EXPLAIN of a read the harness ran without one. Its classification is the `queryType`
 *   the server reported for the run of that same statement, which the capture holds; a statement with no
 *   capture still fails by name.
 * - The gate refusal: a read whose EXPLAIN is answered with the captured classification of `CREATE (n)`.
 * - The AccessMode refusal, which the fixture README records as measured rather than captured; a test below
 *   holds the sentence used here to that README.
 * - The row-bound cut: no capture holds more than `DEFAULT_QUERY_LIMIT` rows, so one run is replayed with a
 *   smaller bound through the recorded client's own slicing.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";
import type { GraphRunOptions, GraphRunResult } from "@/lib/db/graph/bolt/client";
import { cypherForSegment } from "@/lib/db/graph/cypher/generators";
import { graphObjectSegment } from "@/lib/db/graph/objects";
import { Neo4jProvider } from "@/lib/db/providers/graph/neo4j/index";
import { NEO4J_MONITORING_STATEMENTS } from "@/lib/db/providers/graph/neo4j/monitoring-reads";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import {
  capturedError,
  NEO4J_FIXTURES,
  neo4jCapture,
  type RecordedGraphClient,
  recordedGraphClient,
} from "../../helpers/neo4j-fixtures";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// The type-id joins the union in the registration task; until then it is spelled through string.
const NEO4J = "neo4j" as string as DatabaseType;

const CONNECTION: DatabaseConnection = {
  id: "neo4j-live",
  name: "Neo4j 5.26",
  type: NEO4J,
  host: "127.0.0.1",
  port: 7687,
  user: "neo4j",
  password: "libredb-neo4j",
  createdAt: new Date(0),
};

/** The statement of `value-types.json`: every seeded value type and a path. */
const VALUE_TYPES = neo4jCapture("value-types").statement as string;

/** The server's own classification of every captured run, by statement. */
const CLASSIFIED = new Map(
  readdirSync(NEO4J_FIXTURES)
    .filter((file) => file.endsWith(".json") && file !== "verify.json")
    .map((file) => neo4jCapture(file.slice(0, -".json".length)))
    .filter((capture) => capture.result?.queryType !== undefined)
    .map((capture) => [capture.statement as string, capture.result?.queryType]),
);

/** The AccessMode refusal of `CREATE (n)` in a READ session, as the fixture README records it. */
const ACCESS_MODE = {
  category: "access-mode",
  code: "Neo.ClientError.Statement.AccessMode",
  message: "Writing in read access mode not allowed. Attempted write to neo4j",
} as const;

type Replay = (statement: string, options: GraphRunOptions) => Promise<GraphRunResult>;

/**
 * The recorded client, with the gate's EXPLAIN of a captured read answered by that read's own classification,
 * and an optional hook that answers a statement first.
 */
function client(
  hook?: (statement: string, options: GraphRunOptions, replay: Replay) => Promise<GraphRunResult> | undefined,
) {
  const captures = recordedGraphClient();
  const replay: Replay = (statement, options) => {
    const explained = statement.startsWith("EXPLAIN ") ? CLASSIFIED.get(statement.slice("EXPLAIN ".length)) : undefined;
    if (explained !== undefined && !CLASSIFIED.has(statement)) {
      return Promise.resolve({ fields: [], rows: [], truncated: false, queryType: explained });
    }
    return captures.run(statement, options);
  };
  return recordedGraphClient(NEO4J_FIXTURES, {
    run: (statement, options) => hook?.(statement, options, replay) ?? replay(statement, options),
  });
}

async function connected(hook?: Parameters<typeof client>[0]) {
  let recorded: RecordedGraphClient | undefined;
  const provider = new Neo4jProvider(CONNECTION, {}, () => {
    recorded = client(hook);
    return recorded;
  });
  await provider.connect();
  return { provider, calls: (recorded as RecordedGraphClient).calls };
}

describe("connect (spec 6.1, SR4)", () => {
  test("verifies, resolves the home database and reads the kernel's version", async () => {
    const { provider, calls } = await connected();
    expect(provider.isConnected()).toBe(true);
    expect(calls.map((call) => [call.statement, call.options.database])).toEqual([
      ["SHOW HOME DATABASE YIELD name", undefined],
      [NEO4J_MONITORING_STATEMENTS.components, "neo4j"],
    ]);
    expect(await provider.listContainers()).toEqual([
      { path: ["neo4j"], name: "neo4j", level: 0, isSessionDefault: true },
    ]);
    await provider.disconnect();
  });
});

describe("the object surface (spec 4)", () => {
  test("satisfies the object-surface contract on the home database", async () => {
    const { provider } = await connected();
    await assertObjectSurface(provider, {
      // The one container is the home database the connection resolved (SR4).
      containers: [["neo4j"]],
      kinds: { label: 7, relationship_type: 4, index: 2, constraint: 1 },
      sampleObject: { path: ["neo4j", "(:Person)"], kind: "label" },
    });
    await provider.disconnect();
  });

  test("a label with no property has no columns: the seeded Marker", async () => {
    const { provider } = await connected();
    expect((await provider.describeObject(["neo4j", "(:Marker)"], "label")).columns).toEqual([]);
    const person = await provider.describeObject(["neo4j", "(:Person)"], "label");
    expect(person.columns.length).toBeGreaterThan(0);
    expect(person.indexes.map((index) => index.name)).toEqual(["person_name"]);
    await provider.disconnect();
  });
});

describe("the monitoring reads (spec 7)", () => {
  test("health, overview, sessions, tables, indexes and the empty panels", async () => {
    const { provider } = await connected();
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(await provider.getOverview()).toEqual({
      version: "5.26.31 community",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "30 nodes and 40 relationships of 4 relationship types",
      tableCount: 7,
      indexCount: 2,
    });
    const [session] = await provider.getActiveSessions();
    expect(session).toMatchObject({ pid: "neo4j-transaction-18", user: "neo4j", state: "Running", durationMs: 101 });
    expect((await provider.getTableStats()).map((row) => [row.tableName, row.rowCount])).toEqual([
      ["Back`tick", 2],
      ["Marker", 2],
      ["Person", 10],
      ["Service", 8],
      ["Shared", 2],
      ["Team", 4],
      ["Weird Label", 2],
    ]);
    expect((await provider.getIndexStats()).map((row) => [row.indexName, row.isUnique, row.scans])).toEqual([
      ["person_name", false, 30],
      ["service_id", true, 85],
    ]);
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expect(await provider.getPerformanceMetrics()).toEqual({});
    await provider.disconnect();
  });
});

describe("the query path (spec 5)", () => {
  test("every value type reaches the grid JSON-safe", async () => {
    const { provider } = await connected();
    const result = await provider.query(VALUE_TYPES);
    const [row] = result.rows;
    expect(row).toMatchObject({
      anInteger: 42,
      beyondDoubles: "9007199254740993",
      minInteger: "-9223372036854775808",
      notANumber: "NaN",
      aDateTime: "2026-10-03T13:45:30.123456789+03:00[Europe/Istanbul]",
      aDuration: "P1Y2M3DT4H5M6.789000000S",
    });
    expect(row?.path).toMatchObject({
      "~graph": "path",
      nodes: [{ labels: ["Person"] }, { labels: ["Team"] }],
      relationships: [{ "~graph": "relationship", type: "MEMBER_OF" }],
    });
    expect(result.columnTypes).toEqual({ node: "Node", path: "Path" });
    expect(result.pagination).toBeUndefined();
    await provider.disconnect();
  });

  test("a relationship type's generated statement types its three columns", async () => {
    const { provider } = await connected();
    const statement = cypherForSegment(graphObjectSegment("relationship_type", "OWNS")) as string;
    const result = await provider.query(statement);
    expect(result.rowCount).toBe(9);
    expect(result.columnTypes).toEqual({ a: "Node", r: "Relationship", b: "Node" });
    await provider.disconnect();
  });

  test.each(["Weird Label", "Back`tick"])(
    "the generated statement for the label %j runs and returns rows",
    async (label) => {
      const { provider, calls } = await connected();
      const statement = cypherForSegment(graphObjectSegment("label", label)) as string;
      const result = await provider.query(statement);
      expect(result.rowCount).toBe(2);
      expect(calls.slice(-2).map((call) => call.statement)).toEqual([`EXPLAIN ${statement}`, statement]);
      await provider.disconnect();
    },
  );

  test("a write is refused by the policy and makes no run", async () => {
    const { provider, calls } = await connected();
    const before = calls.length;
    await expect(provider.query("CREATE (n:Person {name: 'x'})")).rejects.toThrow(QueryError);
    expect(calls.length).toBe(before);
    await provider.disconnect();
  });

  test("a read the server classifies as a write is refused by the gate, and only the EXPLAIN runs", async () => {
    const write = neo4jCapture("explain-write").result as GraphRunResult;
    const { provider, calls } = await connected((statement) =>
      statement === "EXPLAIN MATCH (n) RETURN n" ? Promise.resolve(write) : undefined,
    );
    const before = calls.length;
    await expect(provider.query("MATCH (n) RETURN n")).rejects.toThrow("classifies this statement as write");
    expect(calls.slice(before).map((call) => call.statement)).toEqual(["EXPLAIN MATCH (n) RETURN n"]);
    await provider.disconnect();
  });

  test("the measured AccessMode refusal says the connection is read-only", async () => {
    expect(readFileSync(join(NEO4J_FIXTURES, "README.md"), "utf8")).toContain(
      `${ACCESS_MODE.code}: ${ACCESS_MODE.message}`,
    );
    const statement = cypherForSegment(graphObjectSegment("label", "Person")) as string;
    const { provider } = await connected((sent) =>
      sent === statement ? Promise.reject(capturedError(ACCESS_MODE)) : undefined,
    );
    const error = await provider.query(statement).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "The server refused a write: Neo4j connections are read-only in this version.",
    );
    await provider.disconnect();
  });

  test("a result beyond the row bound is cut and says so", async () => {
    const statement = cypherForSegment(graphObjectSegment("relationship_type", "MEMBER_OF")) as string;
    const { provider, calls } = await connected((sent, options, replay) =>
      sent === statement ? replay(sent, { ...options, maxRows: 5 }) : undefined,
    );
    const result = await provider.query(statement);
    expect(calls.at(-1)?.options.maxRows).toBe(DEFAULT_QUERY_LIMIT);
    expect(result.rowCount).toBe(5);
    expect(result.pagination).toMatchObject({ wasLimited: true, hasMore: true, limit: DEFAULT_QUERY_LIMIT });
    await provider.disconnect();
  });

  test("a cancel closes the run and reports the cancellation", async () => {
    const statement = cypherForSegment(graphObjectSegment("label", "Service")) as string;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { provider } = await connected((sent, options, replay) => {
      if (sent !== statement) return undefined;
      started();
      return new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve())).then(() =>
        replay(sent, options),
      );
    });
    const query = provider.query(statement, undefined, "q1").catch((caught: unknown) => caught);
    await running;
    expect(await provider.cancelQuery("q1")).toBe(true);
    expect(await query).toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("q1")).toBe(false);
    await provider.disconnect();
  });
});
