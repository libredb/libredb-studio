/**
 * `offersSqlExport`, the one reader of `DialectSpec.offersSqlExport` (vector-family spec 3.10, BACKLOG U69).
 *
 * The real registry answers for every shipped dialect. Qdrant's record is the one shipped record that declines the
 * SQL formats, and two synthetic records, which no shipped dialect is, stand in for one that declines them and one
 * that says so explicitly, so the rule is pinned apart from any engine. The module mock is process-wide, which the runner confines to this file.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DialectSpec } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

const SYNTHETIC_DECLINES = "synthetic-declines-sql";
const SYNTHETIC_OFFERS = "synthetic-offers-sql";
const RECORD: DialectSpec = {
  tabType: "kafka",
  offersColumnProfiling: false,
  offersCodeGeneration: false,
  offersCountQuery: false,
};

const realDialects = { ...(await import("@/lib/db/query-dialects")) };
mock.module("@/lib/db/query-dialects", () => ({
  ...realDialects,
  dialectSpec: (capabilities: ProviderCapabilities | undefined) => {
    const dialect = capabilities?.queryDialect as string | undefined;
    if (dialect === SYNTHETIC_DECLINES) return { ...RECORD, offersSqlExport: false };
    if (dialect === SYNTHETIC_OFFERS) return { ...RECORD, offersSqlExport: true };
    return realDialects.dialectSpec(capabilities);
  },
}));

const { offersSqlExport } = await import("@/lib/db/types");

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

const declaring = (dialect: string): ProviderCapabilities =>
  makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });

describe("offersSqlExport", () => {
  test("offers both formats where no dialect is declared, and while capabilities have not arrived", () => {
    expect(offersSqlExport(undefined)).toBe(true);
    expect(offersSqlExport(makeCaps({ queryLanguage: "sql" }))).toBe(true);
    expect(offersSqlExport(makeCaps({ queryLanguage: "json" }))).toBe(true);
    expect(offersSqlExport(makeCaps({ queryLanguage: "promql" }))).toBe(true);
  });

  test("offers them to every shipped dialect whose record leaves the field absent", () => {
    for (const dialect of ["libredb", "redis", "kafka", "etcd"] as const) {
      expect(offersSqlExport(makeCaps({ queryDialect: dialect })), dialect).toBe(true);
    }
  });

  test("withholds them from milvus, whose record declines them (vector-family spec 5.7)", () => {
    expect(offersSqlExport(makeCaps({ queryDialect: "milvus" }))).toBe(false);
  });

  test("withholds them from qdrant, whose record declines them (vector-family spec 3.10)", () => {
    expect(offersSqlExport(makeCaps({ queryDialect: "qdrant" }))).toBe(false);
  });

  test("offers them to a host's dialect this release has no record for, as the menu always did", () => {
    for (const dialect of ["not-a-registered-dialect", "constructor"]) {
      expect(offersSqlExport(declaring(dialect)), dialect).toBe(true);
    }
  });

  test("withholds them only from a record that declines them", () => {
    expect(offersSqlExport(declaring(SYNTHETIC_DECLINES))).toBe(false);
    expect(offersSqlExport(declaring(SYNTHETIC_OFFERS))).toBe(true);
  });
});
