/**
 * The three row-menu gates read a declared dialect's answers from the dialect registry and from nothing else
 * (vector-family spec 3.8): a dialect added later is one record, and no arm in any gate.
 *
 * The registry is replaced by a stand-in that offers every action to the `libredb` dialect, which the real record
 * refuses all but the code generator, so a gate that still branched on the dialect could not answer `true`. A
 * module mock is process-wide, so the real records' answers are pinned in `dialect-gates-inputs.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DialectSpec } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

const OFFERS_EVERYTHING: DialectSpec = {
  tabType: "libredb",
  offersColumnProfiling: true,
  offersCodeGeneration: true,
  offersCountQuery: true,
};
const OFFERS_NOTHING: DialectSpec = {
  tabType: "kafka",
  offersColumnProfiling: false,
  offersCodeGeneration: false,
  offersCountQuery: false,
};

mock.module("@/lib/db/query-dialects", () => ({
  QUERY_DIALECTS: {},
  dialectSpec: (capabilities: ProviderCapabilities | undefined) => {
    if (capabilities?.queryDialect === undefined) return undefined;
    return capabilities.queryDialect === "libredb" ? OFFERS_EVERYTHING : OFFERS_NOTHING;
  },
  declaresDialect: (capabilities: ProviderCapabilities | undefined) => capabilities?.queryDialect !== undefined,
  registeredDialect: () => undefined,
}));

const { offersCodeGeneration, offersColumnProfiling, offersCountQuery } = await import("@/lib/db/types");

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

describe("the row-menu gates take a declared dialect's answers from its registry record", () => {
  test("a record that offers profiling, code generation and a count is offered all three", () => {
    const caps = makeCaps({ queryDialect: "libredb" });
    expect(offersColumnProfiling(caps)).toBe(true);
    expect(offersCodeGeneration(caps)).toBe(true);
    expect(offersCountQuery(caps)).toBe(true);
  });

  test("a record that offers nothing is offered nothing, Redis's dialect included", () => {
    const caps = makeCaps({ queryDialect: "redis" });
    expect(offersColumnProfiling(caps)).toBe(false);
    expect(offersCodeGeneration(caps)).toBe(false);
    expect(offersCountQuery(caps)).toBe(false);
  });

  test("a derived grouping is still refused its count, whatever the record says", () => {
    expect(offersCountQuery(makeCaps({ queryDialect: "libredb", tablesAreDerivedGroupings: true }))).toBe(false);
  });
});
