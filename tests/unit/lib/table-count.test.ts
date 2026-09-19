import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as generators from "@/lib/query-generators";
import * as formatting from "@/lib/db/utils/pool-manager";
import type { ProviderCapabilities } from "@/lib/db/types";

function caps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return { queryLanguage: "sql", defaultPort: 5432, ...overrides } as ProviderCapabilities;
}

describe("compact row counts (#702)", () => {
  test("the title distinguishes a reported figure from an unavailable count", () => {
    expect(formatting.formatRowCountTitle(1553900)).toContain("1,553,900");
    expect(formatting.formatRowCountTitle(1553900)).toContain("estimate");
    expect(formatting.formatRowCountTitle(-1)).toBe("Row count unavailable");
    expect(formatting.formatRowCountTitle(Number.NaN)).toBe("Row count unavailable");
  });
  test.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [1553900, "1.6M"],
    [1e6, "1M"],
    [1e9, "1B"],
    [1e12, "1T"],
    [999999, "1M"],
    [-1, "N/A"],
    [Number.NaN, "N/A"],
    [Number.POSITIVE_INFINITY, "N/A"],
    [Number.NEGATIVE_INFINITY, "N/A"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatting.formatRowCount(value as number)).toBe(expected);
  });
});

describe("editable count queries (#702)", () => {
  test.each([
    ["PostgreSQL", caps(), ["app", "Order.Items"], 'SELECT COUNT(*) AS row_count\nFROM app."Order.Items";'],
    [
      "MySQL",
      caps({ defaultPort: 3306 }),
      ["app", "Order`Items"],
      "SELECT COUNT(*) AS row_count\nFROM app.`Order``Items`;",
    ],
    ["SQLite", caps({ defaultPort: null }), ["Order.Items"], 'SELECT COUNT(*) AS row_count\nFROM "Order.Items";'],
    ["libSQL", caps({ defaultPort: null }), ["items"], "SELECT COUNT(*) AS row_count\nFROM items;"],
    [
      "DuckDB",
      caps({ defaultPort: null }),
      ["catalog", "app", "items"],
      "SELECT COUNT(*) AS row_count\nFROM catalog.app.items;",
    ],
    [
      "Oracle",
      caps({ defaultPort: 1521, statementTerminator: "none" }),
      ["APP", 'Order"Items'],
      'SELECT COUNT(*) AS row_count\nFROM APP."Order""Items"',
    ],
    [
      "SQL Server",
      caps({ defaultPort: 1433 }),
      ["catalog", "app", "Order]Items"],
      "SELECT COUNT_BIG(*) AS row_count\nFROM catalog.app.[Order]]Items];",
    ],
    [
      "Couchbase",
      caps({ defaultPort: 8091 }),
      ["bucket", "scope", "Order`Items"],
      "SELECT COUNT(*) AS row_count\nFROM `bucket`.`scope`.`Order``Items`;",
    ],
    [
      "ClickHouse",
      caps({ defaultPort: 8123 }),
      ["app", ".inner.items"],
      'SELECT COUNT(*) AS row_count\nFROM app.".inner.items";',
    ],
    ["Druid", caps({ defaultPort: 8888 }), ['Order"Items'], 'SELECT COUNT(*) AS row_count\nFROM "Order""Items";'],
    [
      "Trino",
      caps({ defaultPort: 8080 }),
      ["catalog", "app", "items"],
      "SELECT COUNT(*) AS row_count\nFROM catalog.app.items;",
    ],
    ["Cassandra", caps({ defaultPort: 9042 }), ["app", "items"], "SELECT COUNT(*) AS row_count\nFROM app.items;"],
    [
      "Elasticsearch",
      caps({ defaultPort: 9200, identifierQuoting: "double", statementTerminator: "none" }),
      ["order-items"],
      'SELECT COUNT(*) AS row_count\nFROM "order-items"',
    ],
    [
      "OpenSearch",
      caps({ defaultPort: 9200, identifierQuoting: "backtick" }),
      ["order-items"],
      "SELECT COUNT(*) AS row_count\nFROM `order-items`;",
    ],
  ] as const)("quotes the full %s address without a result limit", (_engine, capabilities, path, expected) => {
    expect(generators.canGenerateCountQuery(capabilities)).toBe(true);
    expect(generators.generateCountQuery(path, capabilities)).toBe(expected);
  });

  test("MongoDB emits an editable count/filter document with a lossless collection name", () => {
    const capabilities = caps({ queryLanguage: "json", defaultPort: 27017 });
    const collection = 'Order.Items"\n';
    expect(JSON.parse(generators.generateCountQuery(["database", collection], capabilities)!)).toEqual({
      collection,
      operation: "count",
      filter: {},
    });
  });

  test.each(["redis", "libredb"] as const)("withholds %s count grammar even for a bare key", (queryDialect) => {
    const capabilities = caps({ queryLanguage: "json", queryDialect });
    expect(generators.canGenerateCountQuery(capabilities)).toBe(false);
    expect(generators.generateCountQuery(["key"], capabilities)).toBeNull();
  });

  test("derived groupings and unresolved metadata have no count action", () => {
    const derived = caps({ tablesAreDerivedGroupings: true });
    expect(generators.canGenerateCountQuery(derived)).toBe(false);
    expect(generators.generateCountQuery(["user:*"], derived)).toBeNull();
    expect(generators.canGenerateCountQuery(undefined)).toBe(false);
  });

  test("refuses an empty object address", () => {
    expect(() => generators.generateCountQuery([], caps())).toThrow("no segments");
  });

  test("counts a real million-row table, and the generated query accepts a filter", () => {
    const db = new Database(":memory:");
    try {
      db.exec('CREATE TABLE "Order.Items" (id INTEGER PRIMARY KEY)');
      db.exec(
        'WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 1553900) INSERT INTO "Order.Items" SELECT id FROM rows',
      );
      const query = generators.generateCountQuery(["Order.Items"], caps({ defaultPort: null }))!;
      expect(db.query(query).get()).toEqual({ row_count: 1553900 });
      expect(db.query(query.replace(/;$/, " WHERE id <= 7;")).get()).toEqual({ row_count: 7 });
      expect(formatting.formatRowCount(1553900)).toBe("1.6M");
    } finally {
      db.close();
    }
  });
});
