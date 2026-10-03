/**
 * The Neo4j provider composed with the real Bolt client (Neo4j provider revision SR21).
 *
 * tests/integration/db/neo4j-provider.test.ts replays captures at the `GraphClient` seam, so the Bolt client's
 * own reading of a result is not in its path. Here the real `Neo4jProvider` runs over the real
 * `buildBoltClient`, and only the driver module is fake: its sessions serve real neo4j-driver-lite records
 * holding real driver value classes (`neo4j.int`, `Node`, `Relationship`, `Path`, temporals), as async-iterable
 * results the way the driver hands them over. That pins, through the whole stack, the row-bound cut (the fake
 * sees its session closed after `DEFAULT_QUERY_LIMIT + 1` records and its summary never read), an error thrown
 * while iterating, the summary read on a short result, and a cancel that closes the session.
 *
 * `mock.module()` is not used: the driver module is a parameter of `buildBoltClient`.
 */
import { describe, expect, test } from "bun:test";
import neo4j from "neo4j-driver-lite";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";
import {
  type BoltDriverModule,
  type BoltRecord,
  type BoltResult,
  buildBoltClient,
} from "@/lib/db/graph/bolt/bolt-client";
import { Neo4jProvider } from "@/lib/db/providers/graph/neo4j/index";
import { NEO4J_MONITORING_STATEMENTS } from "@/lib/db/providers/graph/neo4j/monitoring-reads";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

const { Node, Relationship, Path, PathSegment, DateTime, Record: DriverRecord } = neo4j.types;

const NEO4J: DatabaseType = "neo4j";

const CONNECTION: DatabaseConnection = {
  id: "composed",
  name: "composed",
  type: NEO4J,
  host: "db.example",
  user: "neo4j",
  password: "secret",
  database: "neo4j",
  createdAt: new Date(0),
};

const VALUES = "MATCH p = (a)-[r]->(b) RETURN 1 AS one, a, r, p";
const MANY = "UNWIND range(1, 100000) AS x RETURN x";
const FAILING = "UNWIND [1, 1, 0] AS x RETURN 1 / x AS y";
const SLOW = "UNWIND range(1, 2000000000) AS x RETURN count(x) AS n";

const alice = new Node(neo4j.int(1), ["Person"], { name: "Alice", big: neo4j.int("9007199254740993") }, "4:db:1");
const team = new Node(neo4j.int(2), ["Team"], { name: "Platform" }, "4:db:2");
const member = new Relationship(
  neo4j.int(10),
  neo4j.int(1),
  neo4j.int(2),
  "MEMBER_OF",
  { since: new DateTime(2023, 1, 1, 9, 30, 0, 123456789, 10800, "Europe/Istanbul") },
  "5:db:10",
  "4:db:1",
  "4:db:2",
);
const path = new Path(alice, team, [new PathSegment(alice, member, team)]);

/** What one statement serves: its records (made lazily, so a cut is visible), its type, and an optional fault. */
interface Served {
  readonly keys: readonly string[];
  readonly count: number;
  readonly record: (index: number) => readonly unknown[];
  readonly queryType: string;
  readonly failAfter?: number;
  readonly hang?: boolean;
}

const SERVED: Readonly<Record<string, Served>> = {
  [NEO4J_MONITORING_STATEMENTS.components]: {
    keys: ["name", "versions", "edition"],
    count: 1,
    record: () => ["Neo4j Kernel", ["5.26.31"], "community"],
    queryType: "s",
  },
  [VALUES]: {
    keys: ["one", "a", "r", "p"],
    count: 1,
    record: () => [neo4j.int(1), alice, member, path],
    queryType: "r",
  },
  [MANY]: { keys: ["x"], count: 100_000, record: (index) => [neo4j.int(index + 1)], queryType: "r" },
  [FAILING]: { keys: ["y"], count: 3, record: () => [neo4j.int(1)], queryType: "r", failAfter: 2 },
  [SLOW]: { keys: ["n"], count: 1, record: () => [neo4j.int(0)], queryType: "r", hang: true },
};

interface RunLog {
  readonly statement: string;
  yielded: number;
  summaryReads: number;
  closed: boolean;
}

function fakeDriver() {
  const runs: RunLog[] = [];
  const waiting: { statement: string; resolve: () => void }[] = [];
  /** Resolves once a run of `statement` has started. */
  const ran = (statement: string) => new Promise<void>((resolve) => waiting.push({ statement, resolve }));
  const lib: BoltDriverModule = {
    auth: { basic: (user, password) => ({ scheme: "basic", principal: user, credentials: password }) },
    session: { READ: "READ" },
    driver: () => ({
      verifyConnectivity: async () => undefined,
      getServerInfo: async () => ({
        address: "db.example:7687",
        agent: "Neo4j/5.26.31",
        protocolVersion: { getMajor: () => 5, getMinor: () => 5 },
      }),
      close: async () => undefined,
      session() {
        let log: RunLog | undefined;
        let release: () => void = () => undefined;
        const closed = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          async close() {
            if (log !== undefined) log.closed = true;
            release();
          },
          run(statement): BoltResult {
            const current: RunLog = { statement, yielded: 0, summaryReads: 0, closed: false };
            log = current;
            runs.push(current);
            for (const waiter of waiting) if (waiter.statement === statement) waiter.resolve();
            // The gate's EXPLAIN plans without rows; the server answers it as a read.
            const served: Served = statement.startsWith("EXPLAIN ")
              ? { keys: [], count: 0, record: () => [], queryType: "r" }
              : (SERVED[statement] as Served);
            return {
              keys: async () => served.keys,
              summary: async () => {
                current.summaryReads++;
                return { queryType: served.queryType };
              },
              [Symbol.asyncIterator]() {
                let index = 0;
                return {
                  async next(): Promise<IteratorResult<BoltRecord>> {
                    if (served.hang) {
                      await closed;
                      throw new neo4j.Neo4jError("terminated", "Neo.ClientError.Transaction.Terminated", "25N05", "");
                    }
                    if (current.closed) throw new Error("the session was closed while iterating");
                    if (index === served.failAfter) {
                      throw new neo4j.Neo4jError("/ by zero", "Neo.ClientError.Statement.ArithmeticError", "22012", "");
                    }
                    if (index === served.count) return { done: true, value: undefined };
                    current.yielded++;
                    const value = new DriverRecord([...served.keys], [...served.record(index)]);
                    index++;
                    return { done: false, value };
                  },
                  async return(): Promise<IteratorResult<BoltRecord>> {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
          },
        };
      },
    }),
  };
  return { lib, runs, ran };
}

async function composed() {
  const { lib, runs, ran } = fakeDriver();
  const provider = new Neo4jProvider(CONNECTION, {}, (config) => buildBoltClient(config, lib));
  await provider.connect();
  return { provider, runs, ran };
}

const runOf = (runs: readonly RunLog[], statement: string) => runs.find((run) => run.statement === statement) as RunLog;

describe("Neo4jProvider over the real Bolt client (SR21)", () => {
  test("connect reads the version through a whole result and its summary", async () => {
    const { provider, runs } = await composed();
    expect(runs).toEqual([
      { statement: NEO4J_MONITORING_STATEMENTS.components, yielded: 1, summaryReads: 1, closed: true },
    ]);
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
  });

  test("driver values reach the grid JSON-safe, and a short result reads its summary once", async () => {
    const { provider, runs } = await composed();
    const result = await provider.query(VALUES);
    expect(result.rows).toEqual([
      {
        one: 1,
        a: {
          "~graph": "node",
          elementId: "4:db:1",
          labels: ["Person"],
          properties: { name: "Alice", big: "9007199254740993" },
        },
        r: {
          "~graph": "relationship",
          elementId: "5:db:10",
          type: "MEMBER_OF",
          startNodeElementId: "4:db:1",
          endNodeElementId: "4:db:2",
          properties: { since: "2023-01-01T09:30:00.123456789+03:00[Europe/Istanbul]" },
        },
        p: expect.objectContaining({ "~graph": "path" }),
      },
    ]);
    expect(result.columnTypes).toEqual({ a: "Node", r: "Relationship", p: "Path" });
    expect(runOf(runs, `EXPLAIN ${VALUES}`).summaryReads).toBe(1);
    expect(runOf(runs, VALUES)).toMatchObject({ yielded: 1, summaryReads: 1, closed: true });
    await provider.disconnect();
  });

  test("the row bound closes the session after one record beyond it, without reading the summary", async () => {
    const { provider, runs } = await composed();
    const result = await provider.query(MANY);
    expect(result.rowCount).toBe(DEFAULT_QUERY_LIMIT);
    expect(result.pagination?.wasLimited).toBe(true);
    expect(runOf(runs, MANY)).toMatchObject({ yielded: DEFAULT_QUERY_LIMIT + 1, summaryReads: 0, closed: true });
    await provider.disconnect();
  });

  test("an error while iterating is the server's, through the error table", async () => {
    const { provider, runs } = await composed();
    const error = await provider.query(FAILING).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("/ by zero");
    expect(runOf(runs, FAILING)).toMatchObject({ yielded: 2, closed: true });
    await provider.disconnect();
  });

  test("a cancel closes the session and reports the cancellation", async () => {
    const { provider, runs, ran } = await composed();
    const started = ran(SLOW);
    const query = provider.query(SLOW, undefined, "q1").catch((caught: unknown) => caught);
    await started;
    expect(await provider.cancelQuery("q1")).toBe(true);
    expect(await query).toBeInstanceOf(QueryCancelledError);
    expect(runOf(runs, SLOW).closed).toBe(true);
    await provider.disconnect();
  });
});
