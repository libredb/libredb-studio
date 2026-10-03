/**
 * The pure monitoring mappings of the Milvus provider: each `TableStats`
 * and `IndexStats` sets exactly its mapped fields and no other, the overview leaves out what Milvus does not report,
 * health is CheckHealth's verdict, and the GetMetrics parse keeps only its allowlist.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  formatMilvusBytes,
  loadStateWord,
  NOT_REPORTED,
  ROW_COUNT_ESTIMATE,
  readSystemInfo,
  statisticsRowCount,
  toMilvusHealth,
  toMilvusIndexStats,
  toMilvusOverview,
  toMilvusTableStats,
} from "@/lib/db/providers/vector/milvus/monitoring";
import { kv, OK, SYSTEM_INFO, wireIndex } from "../../../helpers/milvus-catalog-client";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

describe("the small words", () => {
  test("statisticsRowCount reads row_count, and nothing when the answer has none", () => {
    expect(statisticsRowCount([kv("row_count", "2000")])).toBe("2000");
    expect(statisticsRowCount([kv("other", "1")])).toBeUndefined();
  });

  test.each([
    [512, "512 bytes"],
    [1024, "1.0 KiB"],
    [969932800, "925.0 MiB"],
    [543686656, "518.5 MiB"],
    [4294967296, "4.0 GiB"],
  ])("formatMilvusBytes(%i) is %s", (bytes, text) => {
    expect(formatMilvusBytes(bytes)).toBe(text);
  });

  test.each([
    ["LoadStateLoaded", "Loaded"],
    ["LoadStateLoading", "Loading"],
    ["LoadStateNotLoad", "NotLoad"],
    ["LoadStateNotExist", "NotExist"],
    ["SomethingNew", "SomethingNew"],
  ])("loadStateWord(%s) is Milvus's own word %s", (state, word) => {
    expect(loadStateWord(state)).toBe(word);
  });

  test("the estimate wording", () => {
    expect(ROW_COUNT_ESTIMATE).toBe("estimate: flushed segments only, deletes not subtracted, may lag recent inserts");
    expect(NOT_REPORTED).toBe("N/A");
  });
});

describe("toMilvusTableStats", () => {
  test("sets exactly schemaName, tableName, rowCount, totalSize and totalSizeBytes", () => {
    const rows = toMilvusTableStats("default", [
      { collection: "docs_int64", rowCount: "2000" },
      { collection: "empty", rowCount: "0" },
    ]);
    expect(rows).toEqual([
      { schemaName: "default", tableName: "docs_int64", rowCount: 2000, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "default", tableName: "empty", rowCount: 0, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(["rowCount", "schemaName", "tableName", "totalSize", "totalSizeBytes"]);
  });
});

describe("toMilvusIndexStats", () => {
  test("one row per index with exactly its mapped fields, the native index_type as reported", () => {
    const rows = toMilvusIndexStats("default", "docs", [
      wireIndex("vec", "AUTOINDEX", "COSINE"),
      wireIndex("bin", "BIN_FLAT", "HAMMING"),
    ]);
    expect(rows).toEqual([
      {
        schemaName: "default",
        tableName: "docs",
        indexName: "vec",
        indexType: "AUTOINDEX",
        columns: ["vec"],
        isUnique: false,
        isPrimary: false,
        indexSize: "N/A",
        scans: 0,
      },
      {
        schemaName: "default",
        tableName: "docs",
        indexName: "bin",
        indexType: "BIN_FLAT",
        columns: ["bin"],
        isUnique: false,
        isPrimary: false,
        indexSize: "N/A",
        scans: 0,
      },
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "columns",
      "indexName",
      "indexSize",
      "indexType",
      "isPrimary",
      "isUnique",
      "scans",
      "schemaName",
      "tableName",
    ]);
  });

  test("an index that reports no index_type has no indexType, never a guess", () => {
    const [row] = toMilvusIndexStats("default", "docs", [wireIndex("vec", "HNSW", "L2", { params: [] })]);
    expect(Object.hasOwn(row, "indexType")).toBe(false);
  });
});

describe("toMilvusOverview", () => {
  test("the version, the database's collections visible to this user and the index rows; no connection count", () => {
    const overview = toMilvusOverview({ version: "v3.0.2", database: "default", collections: 12, indexes: 9 });
    expect(overview).toEqual({
      version: "v3.0.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 12,
      tableCountSampledFrom: "the collections of database default visible to this Milvus user",
      indexCount: 9,
    });
    expect(Object.hasOwn(overview, "activeConnections")).toBe(false);
  });

  test("a version Studio could not read is not reported", () => {
    expect(toMilvusOverview({ version: undefined, database: "d", collections: 0, indexes: 0 }).version).toBe("N/A");
  });
});

describe("toMilvusHealth", () => {
  test("a healthy server answers no figure Milvus does not report", () => {
    expect(toMilvusHealth({ status: OK, isHealthy: true, reasons: [], quota_states: [] }, [])).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
  });

  test("an unhealthy one is raised in Studio's words, then the server's reasons", () => {
    expect(() =>
      toMilvusHealth({ status: OK, isHealthy: false, reasons: ["querynode down", "quota hit"], quota_states: [] }, []),
    ).toThrow(new QueryError("Milvus reports that it is not healthy: querynode down; quota hit", "milvus"));
    expect(() => toMilvusHealth({ status: OK, isHealthy: false, reasons: [], quota_states: [] }, [])).toThrow(
      "Milvus reports that it is not healthy.",
    );
  });

  test("a reason that holds the configured secret is withheld", () => {
    const error = (() => {
      try {
        toMilvusHealth({ status: OK, isHealthy: false, reasons: [`bad ${TEST_PASSWORD}`], quota_states: [] }, [
          TEST_PASSWORD,
        ]);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("it answered");
    })();
    expect(error.message).not.toContain(TEST_PASSWORD);
    expect(error.message).toContain("withheld");
  });
});

describe("readSystemInfo", () => {
  test("keeps per query node only its role and id, its memory, its memory in use and the data loaded on it", () => {
    const nodes = readSystemInfo(SYSTEM_INFO);
    expect(nodes).toEqual([
      { role: "querynode", id: "1", memory: 4294967296, memoryUsage: 969932800, loadedBinlogSize: 543686656 },
    ]);
    expect(Object.keys(nodes[0]).sort()).toEqual(["id", "loadedBinlogSize", "memory", "memoryUsage", "role"]);
  });

  test("no address, no other database's collection id and no unknown field survives", () => {
    const text = JSON.stringify(readSystemInfo(SYSTEM_INFO));
    for (const dropped of ["172.17.0.2", "469496801668309284", "MARKER_UNKNOWN_FIELD", "jemalloc", "proxy"]) {
      expect(text).not.toContain(dropped);
    }
  });

  test("a figure past 2^53 is read from its exact digits, and one that is not a count is left out", () => {
    const answer = `{"nodes_info":[{"infos":{"type":"querynode","id":7,"hardware_infos":{"memory":18014398509481985,"memory_usage":-1},"quota_metrics":{"LoadedBinlogSize":"many"}}}]}`;
    expect(readSystemInfo(answer)).toEqual([{ role: "querynode", id: "7", memory: 18014398509481984 }]);
  });

  test("a node without an id is named unknown, and one without figures keeps its role and id alone", () => {
    expect(readSystemInfo('{"nodes_info":[{"infos":{"type":"querynode"}}]}')).toEqual([
      { role: "querynode", id: "unknown" },
    ]);
  });

  test("text that is not JSON, or JSON with no node list, is refused in Studio's words", () => {
    expect(() => readSystemInfo("not json")).toThrow(
      "Milvus answered GetMetrics with text that is not JSON, so Studio reads no memory figure from it.",
    );
    expect(() => readSystemInfo('{"nodes":[]}')).toThrow(
      "Milvus answered GetMetrics with no node list, so Studio reads no memory figure from it.",
    );
    expect(() => readSystemInfo("[1]")).toThrow("no node list");
  });
});
