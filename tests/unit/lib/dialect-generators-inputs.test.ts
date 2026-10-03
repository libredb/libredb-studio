/**
 * The two generators over the inputs the dialect registry did not exist for, each answered as before it
 * (vector-family spec 3.8): an address that lost its segments, and a dialect only a host's own declaration can
 * name.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderCapabilities } from "@/lib/db/types";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";
import type { ColumnSchema } from "@/lib/types";

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "json",
    supportsExplain: false,
    supportsExternalQueryLimiting: false,
    supportsCreateTable: false,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort: null,
    ...overrides,
  };
}

const COLUMNS: ColumnSchema[] = [{ name: "id", type: "int", nullable: false, isPrimary: true }];

describe("an address with no segments", () => {
  test("is refused before any dialect spells it, by both generators, for every dialect", () => {
    for (const dialect of ["libredb", "redis", "kafka", "etcd"] as const) {
      const caps = makeCaps({ queryDialect: dialect });
      expect(() => generateTableQuery([], caps, COLUMNS)).toThrow(
        "Cannot generate a query: the object address has no segments.",
      );
      expect(() => generateSelectQuery([], COLUMNS, caps)).toThrow(
        "Cannot generate a query: the object address has no segments.",
      );
    }
  });
});

describe("a host declaring a dialect this release has no record for", () => {
  test("gets the statement its language gives, as before the registry", () => {
    for (const dialect of ["milvus", "constructor", "__proto__"]) {
      const caps = makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });
      expect(JSON.parse(generateTableQuery(["orders"], caps, COLUMNS))).toEqual({
        collection: "orders",
        operation: "find",
        filter: {},
        options: { limit: 50 },
      });
      expect(generateTableQuery(["orders"], { ...caps, queryLanguage: "sql", defaultPort: 5432 })).toBe(
        "SELECT * FROM orders;",
      );
    }
  });
});

describe("a host declaring a dialect that is not a string", () => {
  test("gets the statement its language gives and never throws, as before the registry", () => {
    // An own-key lookup would read `["redis"]` as `redis` and write `TYPE orders` where MongoDB's document stood.
    for (const dialect of [{ toString: 0 }, ["redis"], ["etcd"], 42, true]) {
      const caps = makeCaps({ queryDialect: dialect as unknown as ProviderCapabilities["queryDialect"] });
      expect(JSON.parse(generateTableQuery(["orders"], caps, COLUMNS))).toEqual({
        collection: "orders",
        operation: "find",
        filter: {},
        options: { limit: 50 },
      });
      expect(JSON.parse(generateSelectQuery(["orders"], COLUMNS, caps)).collection).toBe("orders");
    }
  });
});
