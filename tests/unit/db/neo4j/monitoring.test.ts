/**
 * The Neo4j monitoring mappings (Neo4j provider spec 7; revision SR11): pure functions from the answers
 * monitoring-reads.ts validated to the shared monitoring types. A figure Neo4j does not report over Bolt is
 * "N/A" or absent, never a fabricated number.
 */
import { describe, expect, test } from "bun:test";
import {
  isoDurationMs,
  toActiveSessions,
  toHealthInfo,
  toIndexStats,
  toOverview,
  toTableStats,
  versionText,
} from "@/lib/db/providers/graph/neo4j/monitoring";

describe("versionText", () => {
  test("a 5.26 server is its version and edition", () => {
    expect(versionText({ version: "5.26.31", edition: "community" })).toBe("5.26.31 community");
  });

  test("a server outside 5.26 is marked untested", () => {
    expect(versionText({ version: "5.27.0", edition: "enterprise" })).toBe("5.27.0 enterprise (untested)");
    expect(versionText({ version: "2025.01.0", edition: "community" })).toBe("2025.01.0 community (untested)");
  });

  test("an unread version is unknown", () => {
    expect(versionText(undefined)).toBe("unknown");
  });
});

describe("toHealthInfo", () => {
  test("reports nothing Bolt does not publish", () => {
    expect(toHealthInfo()).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  });
});

describe("toOverview", () => {
  const BASE = {
    server: { version: "5.26.31", edition: "community" },
    nodes: 30,
    relationships: 40,
    labels: 7,
    labelsCut: false,
    relationshipTypes: 4,
    relationshipTypesCut: false,
    indexes: 2,
  };

  test("counts labels as tables and states the graph's size in nodes and relationships", () => {
    expect(toOverview(BASE)).toEqual({
      version: "5.26.31 community",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "30 nodes and 40 relationships of 4 relationship types",
      tableCount: 7,
      indexCount: 2,
    });
  });

  test("a cut label or type listing is a floor", () => {
    const overview = toOverview({ ...BASE, labelsCut: true, relationshipTypesCut: true });
    expect(overview.tableCountSampledFrom).toBe("one catalog read that stopped at its row bound");
    expect(overview.databaseSize).toBe("30 nodes and 40 relationships of at least 4 relationship types");
  });

  test("a refused count is said to be unreadable, and a count beyond 2^53 keeps its digits", () => {
    const overview = toOverview({ ...BASE, server: undefined, nodes: undefined, relationships: "9007199254740993" });
    expect(overview.version).toBe("unknown");
    expect(overview.databaseSize).toBe(
      "node count not readable and 9007199254740993 relationships of 4 relationship types",
    );
    expect(toOverview({ ...BASE, relationships: undefined }).databaseSize).toBe(
      "30 nodes and relationship count not readable of 4 relationship types",
    );
  });

  test("a refused label listing is a floor of 0, and a refused type or index listing is said to be unreadable", () => {
    const labels = toOverview({ ...BASE, labels: undefined });
    expect(labels.tableCount).toBe(0);
    expect(labels.tableCountSampledFrom).toBe("a label listing the server refused to read");
    expect(toOverview({ ...BASE, relationshipTypes: undefined }).databaseSize).toBe(
      "30 nodes and 40 relationships, relationship type count not readable",
    );
    const indexes = toOverview({ ...BASE, indexes: undefined });
    expect(indexes.indexCount).toBe(0);
    expect(indexes.databaseSize).toBe(
      "30 nodes and 40 relationships of 4 relationship types, index count not readable",
    );
  });
});

describe("isoDurationMs", () => {
  test.each([
    ["PT0.101000000S", 101],
    ["PT2M3.5S", 123_500],
    ["PT1H", 3_600_000],
    ["P1DT1S", 86_401_000],
    ["PT0S", 0],
    ["P2D", 172_800_000],
    // The driver writes a whole-day Duration with its T: new Duration(0, 1, 0, 0).toString() is "P1DT".
    ["P1DT", 86_400_000],
    // A just-started transaction, read on Neo4j 2026.09.0: the start and the read disagree by a millisecond,
    // and a transaction cannot have run for less than nothing, so it is 0 (#1416).
    ["PT-0.001000000S", 0],
    ["PT-1S", 0],
    // A sign on one component is that component's: the total is what is clamped.
    ["PT1M-0.5S", 59_500],
  ])("%s is %d ms", (text, ms) => {
    expect(isoDurationMs(text)).toBe(ms);
  });

  test.each(["", "P", "PT", "P1Y", "P1M", "1S", "PT--1S", "PT-S", "-PT1S"])("refuses %j", (text) => {
    expect(isoDurationMs(text)).toBeUndefined();
  });
});

describe("toActiveSessions", () => {
  // The monitoring panels count `state === "active"` (SessionsTab, OverviewTab, OperationsTab), the word
  // PostgreSQL gives a statement in flight; Neo4j's `Running` is that state, and its other statuses keep
  // their own words, lower-cased, so they are counted as neither active nor idle.
  test.each([
    ["Running", "active"],
    ["Blocked", "blocked"],
    ["Closing", "closing"],
    ["Terminated", "terminated"],
  ])("maps the transaction status %s to the panel state %s", (status, state) => {
    const [session] = toActiveSessions([
      {
        database: "neo4j",
        transactionId: "neo4j-transaction-1",
        username: "neo4j",
        currentQuery: "RETURN 1",
        startTime: "2026-10-03T05:18:20.881Z",
        status,
        durationMs: 1,
      },
    ]);
    expect(session?.state).toBe(state);
  });

  test("one session per transaction, its id as the pid", () => {
    expect(
      toActiveSessions([
        {
          database: "neo4j",
          transactionId: "neo4j-transaction-18",
          username: "neo4j",
          currentQuery: "MATCH (n) RETURN n",
          startTime: "2026-10-03T05:18:20.881Z",
          status: "Running",
          durationMs: 101,
        },
      ]),
    ).toEqual([
      {
        pid: "neo4j-transaction-18",
        user: "neo4j",
        database: "neo4j",
        state: "active",
        query: "MATCH (n) RETURN n",
        queryStart: new Date("2026-10-03T05:18:20.881Z"),
        duration: "101ms",
        durationMs: 101,
      },
    ]);
  });
});

describe("toTableStats", () => {
  test("one row per label with its node count, and no size", () => {
    expect(
      toTableStats("neo4j", [
        { label: "Person", count: 10 },
        { label: "Big", count: "9007199254740993" },
      ]),
    ).toEqual([
      { schemaName: "neo4j", tableName: "Person", rowCount: 10, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "neo4j", tableName: "Big", rowCount: 9007199254740992, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
  });
});

describe("toIndexStats", () => {
  test("reads become scans; a state other than ONLINE is named beside the type", () => {
    expect(
      toIndexStats("neo4j", [
        {
          name: "person_name",
          type: "RANGE",
          labelsOrTypes: ["Person"],
          properties: ["name"],
          state: "ONLINE",
          readCount: 30,
          populationPercent: 100,
          unique: false,
        },
        {
          name: "pair",
          type: "TEXT",
          labelsOrTypes: ["A", "B"],
          properties: ["x", "y"],
          state: "POPULATING",
          readCount: "9007199254740993",
          populationPercent: 42.5,
          unique: true,
        },
      ]),
    ).toEqual([
      {
        schemaName: "neo4j",
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
        schemaName: "neo4j",
        tableName: "A, B",
        indexName: "pair",
        indexType: "TEXT (POPULATING, 42.5% populated)",
        columns: ["x", "y"],
        isUnique: true,
        isPrimary: false,
        indexSize: "N/A",
        scans: 9007199254740992,
      },
    ]);
  });
});
