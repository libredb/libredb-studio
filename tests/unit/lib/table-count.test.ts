import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as generators from "@/lib/query-generators";
import * as formatting from "@/lib/db/utils/pool-manager";
import { createDatabaseProvider } from "@/lib/db/factory";
import { offersCountQuery, type ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

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

/**
 * What `generateCountQuery` writes for every shipped type-id, from each provider's OWN
 * `getCapabilities()` rather than from a hand-built capabilities object. A synthetic fixture
 * can claim a terminator or a quote character the provider does not declare and pass anyway:
 * the first version of this file expected `;` after Trino and OpenSearch, both of which declare
 * `statementTerminator: "none"`. Nothing here connects; see `CENSUS_CONNECTION`.
 *
 * The object segment is `Order"Items` so every row shows its dialect's quote and its escape,
 * and each container level is a plain lower-case name so the row shows which engines quote a
 * name that needs no quoting. `null` is "no action": a language with no count grammar here, or
 * a derived grouping with nothing to count. A Record, so a new member of the union is a compile
 * error rather than an engine this census skips.
 */
const EXPECTED_COUNT: Readonly<Record<DatabaseType, string | null>> = Object.freeze({
  postgres: 'SELECT COUNT(*) AS row_count\nFROM c0."Order""Items";',
  mysql: 'SELECT COUNT(*) AS row_count\nFROM c0.`Order"Items`;',
  sqlite: 'SELECT COUNT(*) AS row_count\nFROM "Order""Items";',
  libsql: 'SELECT COUNT(*) AS row_count\nFROM "Order""Items";',
  duckdb: 'SELECT COUNT(*) AS row_count\nFROM c0.c1."Order""Items";',
  oracle: 'SELECT COUNT(*) AS row_count\nFROM "c0"."Order""Items"',
  // COUNT answers an int on SQL Server and overflows past 2,147,483,647 rows.
  mssql: 'SELECT COUNT_BIG(*) AS row_count\nFROM c0.c1.[Order"Items];',
  clickhouse: 'SELECT COUNT(*) AS row_count\nFROM c0."Order""Items";',
  druid: 'SELECT COUNT(*) AS row_count\nFROM "c0"."Order""Items";',
  trino: 'SELECT COUNT(*) AS row_count\nFROM c0.c1."Order""Items"',
  cassandra: 'SELECT COUNT(*) AS row_count\nFROM c0."Order""Items";',
  elasticsearch: 'SELECT COUNT(*) AS row_count\nFROM "Order""Items"',
  opensearch: 'SELECT COUNT(*) AS row_count\nFROM `Order"Items`',
  couchbase: 'SELECT COUNT(*) AS row_count\nFROM `c0`.`c1`.`Order"Items`;',
  // The database rides as its own key (#843), or the count answers for the connected
  // database's same-named collection.
  mongodb: '{\n  "database": "c0",\n  "collection": "Order\\"Items",\n  "operation": "count",\n  "filter": {}\n}',
  redis: null,
  libredb: null,
  prometheus: null,
  // A read request is JSON of its own dialect (#1088), and its grammar has no count to write.
  kafka: null,
});

async function censusCapabilities(type: DatabaseType): Promise<ProviderCapabilities> {
  return (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
}

function censusPath(capabilities: ProviderCapabilities): string[] {
  return [...(capabilities.containerLevels ?? []).map((_, index) => `c${index}`), 'Order"Items'];
}

describe("editable count queries (#702)", () => {
  test.each(Object.keys(EXPECTED_COUNT) as DatabaseType[])(
    "%s writes the count its own capabilities call for, with no result limit",
    async (type) => {
      const capabilities = await censusCapabilities(type);
      const expected = EXPECTED_COUNT[type];
      expect(offersCountQuery(capabilities)).toBe(expected !== null);
      expect(generators.generateCountQuery(censusPath(capabilities), capabilities)).toBe(expected);
    },
  );

  test("unresolved metadata is not a permission", () => {
    expect(offersCountQuery(undefined)).toBe(false);
  });

  test("MongoDB emits an editable count/filter document with a lossless collection name", () => {
    const capabilities = caps({
      queryLanguage: "json",
      defaultPort: 27017,
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
    });
    const collection = 'Order.Items"\n';
    expect(JSON.parse(generators.generateCountQuery(["shop", collection], capabilities)!)).toEqual({
      database: "shop",
      collection,
      operation: "count",
      filter: {},
    });
  });

  test("a derived grouping on a language that has a count grammar is still not counted", () => {
    // No shipped provider pairs the two, so the census above cannot reach this arm: Redis and
    // LibreDB are refused by their dialect first. The grouping alone must be enough.
    const derived = caps({ tablesAreDerivedGroupings: true });
    expect(offersCountQuery(derived)).toBe(false);
    expect(generators.generateCountQuery(["user:*"], derived)).toBeNull();
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
