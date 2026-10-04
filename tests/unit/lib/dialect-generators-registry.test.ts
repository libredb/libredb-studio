/**
 * `generateTableQuery` and `generateSelectQuery` reach a dialect's text through the dialect registry and through
 * nothing else (vector-family spec 3.8): a dialect added later is one record, and no arm in either generator.
 *
 * The registry is replaced by a stand-in that names the Kafka dialect for a PromQL or an InfluxQL declaration, which
 * no real declaration does, so a generator that still branched on `queryDialect` could not write a Kafka read
 * request for it, and one that asked its language arm first would write PromQL or InfluxQL. A module mock is
 * process-wide, so the real records' text is pinned in `dialect-generators-inputs.test.ts` and by the golden file of
 * `tests/isolated/dialect-golden.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ProviderCapabilities } from "@/lib/db/types";

mock.module("@/lib/db/query-dialects", () => ({
  QUERY_DIALECTS: {},
  dialectSpec: () => undefined,
  declaresDialect: (capabilities: ProviderCapabilities | undefined) => capabilities?.queryDialect !== undefined,
  registeredDialect: (capabilities: ProviderCapabilities | undefined) =>
    capabilities?.queryLanguage === "promql" || capabilities?.queryLanguage === "influxql" ? "kafka" : undefined,
}));

const { generateSelectQuery, generateTableQuery } = await import("@/lib/query-generators");

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "promql",
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

describe("the generators take a dialect's text from its DIALECT_GENERATORS record", () => {
  test("a tree click writes the record's read, ahead of the language's own arm", () => {
    expect(JSON.parse(generateTableQuery(["orders"], makeCaps()))).toEqual({
      topic: "orders",
      from: "latest",
      limit: 50,
    });
  });

  test("Generate Query writes the record's text, ahead of the language's own arm", () => {
    expect(JSON.parse(generateSelectQuery(["orders"], [], makeCaps()))).toEqual({
      topic: "orders",
      partition: 0,
      from: "earliest",
      limit: 50,
    });
  });
});

describe("the record comes ahead of the InfluxQL arm too (InfluxDB spec 6.7)", () => {
  test("a tree click and Generate Query write the record's text, never the InfluxQL preview", () => {
    const caps = makeCaps({ queryLanguage: "influxql" });
    expect(JSON.parse(generateTableQuery(["orders"], caps))).toEqual({ topic: "orders", from: "latest", limit: 50 });
    expect(JSON.parse(generateSelectQuery(["orders"], [], caps))).toEqual({
      topic: "orders",
      partition: 0,
      from: "earliest",
      limit: 50,
    });
  });
});
