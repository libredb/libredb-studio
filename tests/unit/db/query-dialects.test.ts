import { describe, expect, test } from "bun:test";
import {
  declaresDialect,
  type DialectSpec,
  dialectSpec,
  QUERY_DIALECTS,
  registeredDialect,
} from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

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

/** A declaration a host may hand `StudioWorkspace` that no shipped provider makes: the union does not allow it. */
function hostDeclaring(dialect: string): ProviderCapabilities {
  return makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });
}

describe("QUERY_DIALECTS", () => {
  test("holds one record per member of the queryDialect union, and nothing else", () => {
    expect(Object.keys(QUERY_DIALECTS).sort()).toEqual(["etcd", "kafka", "libredb", "redis"]);
  });

  test("each record holds the answers the per-dialect arms gave before the registry", () => {
    // The values the golden file of the base commit records (tests/fixtures/dialect-registry).
    expect(QUERY_DIALECTS).toEqual({
      libredb: {
        tabType: "libredb",
        offersColumnProfiling: false,
        offersCodeGeneration: true,
        offersCountQuery: false,
      },
      redis: { tabType: "redis", offersColumnProfiling: false, offersCodeGeneration: true, offersCountQuery: false },
      kafka: { tabType: "kafka", offersColumnProfiling: false, offersCodeGeneration: false, offersCountQuery: false },
      etcd: { tabType: "etcd", offersColumnProfiling: false, offersCodeGeneration: false, offersCountQuery: false },
    });
  });

  test("is frozen, so no reader can change another reader's answer at run time", () => {
    expect(Object.isFrozen(QUERY_DIALECTS)).toBe(true);
  });

  test("freezes every record too, so no reader can turn one dialect's gate on at run time", () => {
    for (const [dialect, spec] of Object.entries(QUERY_DIALECTS)) {
      expect(Object.isFrozen(spec), `the ${dialect} record is mutable`).toBe(true);
    }
  });

  test("a record may decline the SQL export formats, and none does, so every shipped engine keeps both", () => {
    const declining: DialectSpec = {
      tabType: "kafka",
      offersColumnProfiling: false,
      offersCodeGeneration: false,
      offersCountQuery: false,
      offersSqlExport: false,
    };
    expect(declining.offersSqlExport).toBe(false);
    for (const [dialect, spec] of Object.entries(QUERY_DIALECTS)) {
      expect(Object.hasOwn(spec, "offersSqlExport"), `the ${dialect} record declares offersSqlExport`).toBe(false);
    }
  });
});

describe("registeredDialect, dialectSpec and declaresDialect", () => {
  test("a declared, registered dialect is found, with its record", () => {
    for (const dialect of ["libredb", "redis", "kafka", "etcd"] as const) {
      const caps = makeCaps({ queryDialect: dialect });
      expect(registeredDialect(caps)).toBe(dialect);
      expect(dialectSpec(caps)).toBe(QUERY_DIALECTS[dialect]);
      expect(declaresDialect(caps)).toBe(true);
    }
  });

  test("no dialect declared, and no capabilities yet, find nothing and declare nothing", () => {
    for (const caps of [
      makeCaps(),
      makeCaps({ queryLanguage: "sql" }),
      makeCaps({ queryDialect: undefined }),
      undefined,
    ]) {
      expect(registeredDialect(caps)).toBeUndefined();
      expect(dialectSpec(caps)).toBeUndefined();
      expect(declaresDialect(caps)).toBe(false);
    }
  });

  test("a dialect with no record, from a host's own declaration, is declared but finds nothing", () => {
    for (const dialect of ["milvus", "Redis", ""]) {
      expect(registeredDialect(hostDeclaring(dialect))).toBeUndefined();
      expect(dialectSpec(hostDeclaring(dialect))).toBeUndefined();
      expect(declaresDialect(hostDeclaring(dialect))).toBe(true);
    }
  });

  test("a dialect named like an Object.prototype member is looked up as an own key and finds nothing", () => {
    for (const dialect of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(registeredDialect(hostDeclaring(dialect))).toBeUndefined();
      expect(dialectSpec(hostDeclaring(dialect))).toBeUndefined();
    }
  });
});
