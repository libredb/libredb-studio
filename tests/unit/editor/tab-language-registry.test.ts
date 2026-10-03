/**
 * `resolveTabType` and `editorLanguageForTabType` answer from the dialect registries and from nothing else
 * (vector-family spec 3.8): a dialect added later is one record in each, and no arm in either function.
 *
 * Both registries are replaced here by stand-ins whose answers no shipped dialect gives, so a function that still
 * branched on its own could not produce them. bun's module mocks are process-wide, which is why this lives in a
 * file of its own and the real records' answers are pinned in `tab-language-inputs.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DialectSpec } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

/** A record that types a PromQL connection's tabs as Redis tabs, which no real declaration does. */
const STAND_IN_SPEC: DialectSpec = {
  tabType: "redis",
  offersColumnProfiling: false,
  offersCodeGeneration: false,
  offersCountQuery: false,
};

mock.module("@/lib/db/query-dialects", () => ({
  QUERY_DIALECTS: {},
  dialectSpec: (capabilities: ProviderCapabilities | undefined) =>
    capabilities?.queryLanguage === "promql" ? STAND_IN_SPEC : undefined,
  declaresDialect: () => false,
  registeredDialect: () => undefined,
}));

mock.module("@/lib/editor/dialect-editors", () => ({
  // Every tab type renders in `etcd` here, which only the etcd tab does for real.
  DIALECT_EDITORS: {
    sql: { monacoId: "etcd" },
    mongodb: { monacoId: "etcd" },
    libredb: { monacoId: "etcd" },
    redis: { monacoId: "etcd" },
    promql: { monacoId: "etcd" },
    kafka: { monacoId: "etcd" },
    etcd: { monacoId: "etcd" },
  },
  formatterForLanguage: () => undefined,
}));

const { editorLanguageForTabType, resolveTabType } = await import("@/lib/editor/tab-language");

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "sql",
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

describe("the tab-type and language readers take their answers from the registries", () => {
  test("resolveTabType answers the registry record's tabType before reading the language", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "promql" }))).toBe("redis");
  });

  test("without a record, resolveTabType keeps its language rungs", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "json" }))).toBe("mongodb");
    expect(resolveTabType(makeCaps())).toBe("sql");
  });

  test("editorLanguageForTabType answers the editor record's monacoId", () => {
    expect(editorLanguageForTabType("sql")).toBe("etcd");
    expect(editorLanguageForTabType("mongodb")).toBe("etcd");
  });
});
