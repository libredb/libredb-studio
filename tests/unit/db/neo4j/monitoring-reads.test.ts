/**
 * The Neo4j monitoring reads (Neo4j provider spec 7; revisions SR9, SR11) over the 5.26.31 captures of the
 * seeded graph, and over fake answers for what the seed does not hold: a refused read, a server that
 * cannot be reached, more labels than the table-stats bound, a label no statement can name, and rows a
 * server should never send.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import {
  type GraphClient,
  GraphClientError,
  type GraphRunOptions,
  type GraphRunResult,
} from "@/lib/db/graph/bolt/client";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { NEO4J_CATALOG_STATEMENTS } from "@/lib/db/providers/graph/neo4j/catalog";
import {
  isRefusal,
  labelCountStatement,
  NEO4J_MONITORING_STATEMENTS,
  readActiveSessions,
  readIndexStats,
  readOverview,
  readPing,
  readServerVersion,
  readTableStats,
  TABLE_STATS_LABEL_BOUND,
} from "@/lib/db/providers/graph/neo4j/monitoring-reads";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const DATABASE = "neo4j";
const SERVER = { version: "5.26.31", edition: "community" };
const { components, ping, transactions, nodeCount, indexUsage } = NEO4J_MONITORING_STATEMENTS;

type Answer = GraphRunResult | Error;

/** The captures, with the given statements answered (or failed) by the test instead; every run is recorded. */
function replacing(answers: Readonly<Record<string, Answer>> = {}) {
  const recorded = recordedGraphClient();
  const calls: { statement: string; options: GraphRunOptions }[] = [];
  const client: Pick<GraphClient, "run"> = {
    async run(statement, options) {
      calls.push({ statement, options });
      const answer = answers[statement];
      if (answer instanceof Error) throw answer;
      return answer ?? recorded.run(statement, options);
    },
  };
  return { client, calls };
}

const rows = (...answered: Record<string, unknown>[]): GraphRunResult => ({
  fields: Object.keys(answered[0] ?? {}),
  rows: answered,
  truncated: false,
});

const refused = () => new GraphClientError("access-mode", "Permission denied", "Neo.ClientError.Security.Forbidden");
const unreachable = () => new GraphClientError("connection", "Connection refused");

describe("the monitoring statements", () => {
  test("every one but the transaction read passes the read policy", () => {
    for (const statement of [components, ping, nodeCount, NEO4J_MONITORING_STATEMENTS.relationshipCount, indexUsage]) {
      const verdict = checkCypherRead(statement, NEO4J_POLICY_PROFILE);
      if (!verdict.allowed) throw new Error(`${statement}: ${verdict.refusal.message}`);
    }
  });

  test("the transaction read is refused to a user (SR9) and yields no parameters column (E10)", () => {
    const verdict = checkCypherRead(transactions, NEO4J_POLICY_PROFILE);
    expect(verdict.allowed ? undefined : verdict.refusal.code).toBe("denied-show");
    expect(transactions).not.toContain("parameters");
    expect(transactions).not.toContain("*");
  });

  test("a label count is built quoted and passes the read policy (SR11)", () => {
    for (const label of ["Person", "Weird Label", "Back`tick", "Ünïcode"]) {
      const statement = labelCountStatement(label) as string;
      expect(checkCypherRead(statement, NEO4J_POLICY_PROFILE).allowed).toBe(true);
    }
    expect(labelCountStatement("Back`tick")).toBe("MATCH (n:`Back``tick`) RETURN count(n) AS c");
  });

  test("a label no quoted name can carry has no count statement", () => {
    expect(labelCountStatement("Bad\u0001Label")).toBeUndefined();
  });
});

describe("isRefusal", () => {
  test("a server's refusal of the read, and nothing else", () => {
    expect(isRefusal(refused())).toBe(true);
    expect(isRefusal(new GraphClientError("query", "Unknown procedure"))).toBe(true);
    expect(isRefusal(new GraphClientError("syntax", "Invalid input"))).toBe(true);
    expect(isRefusal(unreachable())).toBe(false);
    expect(isRefusal(new GraphClientError("cancelled", "The query was cancelled"))).toBe(false);
    expect(isRefusal(new Error("Permission denied"))).toBe(false);
  });
});

describe("readServerVersion", () => {
  test("the kernel's version and edition, from the capture", async () => {
    const { client, calls } = replacing();
    expect(await readServerVersion(client, DATABASE)).toEqual(SERVER);
    expect(calls[0]?.options).toMatchObject({ database: DATABASE, maxRows: DEFAULT_QUERY_LIMIT });
  });

  test("an answer with no kernel row, or a kernel naming no version, is refused by statement", async () => {
    const none = replacing({ [components]: rows({ name: "Other", versions: ["1"], edition: "x" }) });
    await expect(readServerVersion(none.client, DATABASE)).rejects.toThrow(QueryError);
    const empty = replacing({ [components]: rows({ name: "Neo4j Kernel", versions: [], edition: "community" }) });
    await expect(readServerVersion(empty.client, DATABASE)).rejects.toThrow("versions");
    const wrong = replacing({ [components]: rows({ name: "Neo4j Kernel", versions: "5.26.31", edition: 5 }) });
    await expect(readServerVersion(wrong.client, DATABASE)).rejects.toThrow("a list of strings");
    const edition = replacing({ [components]: rows({ name: "Neo4j Kernel", versions: ["5.26.31"], edition: 5 }) });
    await expect(readServerVersion(edition.client, DATABASE)).rejects.toThrow("edition");
  });
});

describe("readPing", () => {
  test("the captured success resolves", async () => {
    const { client, calls } = replacing();
    await readPing(client, DATABASE);
    expect(calls.map((call) => call.statement)).toEqual([ping]);
  });

  test("an answer that is not one success is a connection fault", async () => {
    const failed = replacing({ [ping]: rows({ success: false }) });
    await expect(readPing(failed.client, DATABASE)).rejects.toThrow(ConnectionError);
    const nothing = replacing({ [ping]: rows() });
    await expect(readPing(nothing.client, DATABASE)).rejects.toThrow("db.ping()");
  });
});

describe("readOverview", () => {
  test("counts from the captures: labels as tables, created indexes, nodes and relationships", async () => {
    const { client } = replacing();
    expect(await readOverview(client, DATABASE, SERVER)).toEqual({
      version: "5.26.31 community",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "30 nodes and 40 relationships of 4 relationship types",
      tableCount: 7,
      indexCount: 2,
    });
  });

  test("a refused node count is said to be unreadable; the rest is still answered", async () => {
    const { client } = replacing({ [nodeCount]: refused() });
    const overview = await readOverview(client, DATABASE, undefined);
    expect(overview.version).toBe("unknown");
    expect(overview.databaseSize).toBe("node count not readable and 40 relationships of 4 relationship types");
  });

  test("a cut label listing is a floor", async () => {
    const { client } = replacing({ [NEO4J_CATALOG_STATEMENTS.label]: { ...rows({ label: "A" }), truncated: true } });
    expect((await readOverview(client, DATABASE, SERVER)).tableCountSampledFrom).toBeDefined();
  });

  test("a server that cannot be reached is thrown, not reported as a refusal", async () => {
    const { client } = replacing({ [nodeCount]: unreachable() });
    await expect(readOverview(client, DATABASE, SERVER)).rejects.toThrow("Connection refused");
  });

  test("a count of the wrong shape is refused by statement", async () => {
    const { client } = replacing({ [nodeCount]: rows({ nodes: 1.5 }) });
    await expect(readOverview(client, DATABASE, SERVER)).rejects.toThrow("a count");
    const none = replacing({ [nodeCount]: rows() });
    await expect(readOverview(none.client, DATABASE, SERVER)).rejects.toThrow("a count");
  });
});

describe("readActiveSessions", () => {
  test("the captured transaction, with its fixed columns", async () => {
    const { client } = replacing();
    expect(await readActiveSessions(client, DATABASE)).toEqual([
      {
        pid: "neo4j-transaction-18",
        user: "neo4j",
        database: "neo4j",
        state: "Running",
        query: transactions,
        queryStart: new Date("2026-10-03T05:18:20.881Z"),
        duration: "101ms",
        durationMs: 101,
      },
    ]);
  });

  test("a refused read is no sessions; an unreachable server is thrown", async () => {
    expect(await readActiveSessions(replacing({ [transactions]: refused() }).client, DATABASE)).toEqual([]);
    await expect(readActiveSessions(replacing({ [transactions]: unreachable() }).client, DATABASE)).rejects.toThrow(
      GraphClientError,
    );
  });

  test("an elapsed time that is not a duration is refused by statement", async () => {
    const row = {
      database: "neo4j",
      transactionId: "t",
      username: "u",
      currentQuery: "q",
      startTime: "2026-10-03T05:18:20.881Z",
      status: "Running",
      elapsedTime: "soon",
    };
    await expect(readActiveSessions(replacing({ [transactions]: rows(row) }).client, DATABASE)).rejects.toThrow(
      "elapsedTime",
    );
  });
});

describe("readTableStats", () => {
  test("one node count per seeded label, sorted by name, from the captures", async () => {
    const { client, calls } = replacing();
    const stats = await readTableStats(client, DATABASE);
    expect(stats.map((row) => [row.tableName, row.rowCount])).toEqual([
      ["Back`tick", 2],
      ["Marker", 2],
      ["Person", 10],
      ["Service", 8],
      ["Shared", 2],
      ["Team", 4],
      ["Weird Label", 2],
    ]);
    expect(stats[0]?.schemaName).toBe(DATABASE);
    expect(calls.map((call) => call.statement)).toContain("MATCH (n:`Weird Label`) RETURN count(n) AS c");
  });

  test(`counts only the first ${TABLE_STATS_LABEL_BOUND} labels by name, and skips one no statement can name`, async () => {
    const labels = Array.from({ length: 60 }, (_, index) => `L${String(index).padStart(2, "0")}`);
    labels.push("A\u0001bad");
    const counts: Record<string, Answer> = {};
    for (const label of labels) counts[`MATCH (n:\`${label}\`) RETURN count(n) AS c`] = rows({ c: 1 });
    const { client, calls } = replacing({
      [NEO4J_CATALOG_STATEMENTS.label]: rows(...[...labels].reverse().map((label) => ({ label }))),
      ...counts,
    });
    const stats = await readTableStats(client, DATABASE);
    // "A\u0001bad" sorts first, takes a place among the fifty and is left out: TableStats has no notice field.
    expect(stats.map((row) => row.tableName)).toEqual(labels.slice(0, TABLE_STATS_LABEL_BOUND - 1));
    expect(calls.filter((call) => call.statement.startsWith("MATCH")).length).toBe(TABLE_STATS_LABEL_BOUND - 1);
  });

  test("a refused listing or count is no rows; an unreachable server is thrown", async () => {
    expect(await readTableStats(replacing({ [NEO4J_CATALOG_STATEMENTS.label]: refused() }).client, DATABASE)).toEqual(
      [],
    );
    const person = "MATCH (n:`Person`) RETURN count(n) AS c";
    expect(await readTableStats(replacing({ [person]: refused() }).client, DATABASE)).toEqual([]);
    await expect(readTableStats(replacing({ [person]: unreachable() }).client, DATABASE)).rejects.toThrow(
      GraphClientError,
    );
  });
});

describe("readIndexStats", () => {
  test("the created indexes from the capture, unique where a constraint owns the index", async () => {
    const { client } = replacing();
    expect(await readIndexStats(client, DATABASE)).toEqual([
      {
        schemaName: DATABASE,
        tableName: "Person",
        indexName: "person_name",
        indexType: "RANGE",
        columns: ["name"],
        isUnique: false,
        isPrimary: false,
        indexSize: "N/A",
        scans: 30,
      },
      {
        schemaName: DATABASE,
        tableName: "Service",
        indexName: "service_id",
        indexType: "RANGE",
        columns: ["id"],
        isUnique: true,
        isPrimary: false,
        indexSize: "N/A",
        scans: 85,
      },
    ]);
  });

  test("an index with no tracked read has made no scan", async () => {
    const usage = {
      name: "person_name",
      type: "RANGE",
      entityType: "NODE",
      labelsOrTypes: ["Person"],
      properties: ["name"],
      state: "ONLINE",
      readCount: null,
      lastRead: null,
      populationPercent: 100,
    };
    const stats = await readIndexStats(replacing({ [indexUsage]: rows(usage) }).client, DATABASE);
    expect(stats.map((row) => row.scans)).toEqual([0]);
  });

  test("a population that is not a number is refused by statement", async () => {
    const usage = {
      name: "person_name",
      type: "RANGE",
      labelsOrTypes: ["Person"],
      properties: ["name"],
      state: "ONLINE",
      readCount: 1,
      populationPercent: "all",
    };
    await expect(readIndexStats(replacing({ [indexUsage]: rows(usage) }).client, DATABASE)).rejects.toThrow(
      "populationPercent",
    );
  });

  test("a refused read is no rows; an unreachable server is thrown", async () => {
    expect(await readIndexStats(replacing({ [indexUsage]: refused() }).client, DATABASE)).toEqual([]);
    await expect(readIndexStats(replacing({ [indexUsage]: unreachable() }).client, DATABASE)).rejects.toThrow(
      GraphClientError,
    );
  });
});
