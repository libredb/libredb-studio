import { describe, expect, test } from "bun:test";
import { DB_TYPES_PREVIEW } from "@/components/admin/tabs/OverviewTab";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

// Use the real preview and external-engine catalog, without module mocks. The card's
// render tests mock db-ui-config, so category coverage is checked independently here
// using stable type-ids rather than display copy.

describe("OverviewTab DB_TYPES_PREVIEW", () => {
  test("every previewed type-id is a real external engine", () => {
    for (const type of DB_TYPES_PREVIEW) {
      expect(EXTERNAL_DATABASE_TYPES).toContain(type);
    }
  });

  test("spans relational, document, key-value, wide-column, search and analytics, not six flavours of one category", () => {
    const categories: Record<string, readonly DatabaseType[]> = {
      relational: ["postgres", "mysql", "sqlite", "libsql", "oracle", "db2", "mssql"],
      document: ["mongodb", "couchbase"],
      "key-value": ["redis"],
      "wide-column": ["cassandra"],
      search: ["elasticsearch", "opensearch"],
      analytics: ["duckdb", "clickhouse", "druid", "trino"],
    };
    for (const [category, typeIds] of Object.entries(categories)) {
      expect(
        DB_TYPES_PREVIEW.some((type) => typeIds.includes(type)),
        `Missing ${category} category in DB_TYPES_PREVIEW`,
      ).toBe(true);
    }
  });

  test("stays shorter than the full catalog, so the card still names a hidden remainder", () => {
    expect(DB_TYPES_PREVIEW.length).toBeLessThan(EXTERNAL_DATABASE_TYPES.length);
  });
});
