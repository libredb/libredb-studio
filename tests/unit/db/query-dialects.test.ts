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
    expect(Object.keys(QUERY_DIALECTS).sort()).toEqual([
      "etcd",
      "kafka",
      "libredb",
      "milvus",
      "oxia",
      "qdrant",
      "redis",
    ]);
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
      milvus: {
        tabType: "milvus",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: false,
      },
      qdrant: {
        tabType: "qdrant",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: false,
      },
      // Oxia (SB2-4.4): records of a fixed shape, no profile, model or count statement, and no SQL export.
      oxia: {
        tabType: "oxia",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: false,
      },
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

  test("a record may decline the SQL export formats, and only milvus's, qdrant's and oxia's do, so every other shipped engine keeps both", () => {
    // `bun run typecheck` is the assertion for the field: this literal compiles only while `DialectSpec` declares
    // `offersSqlExport`, and bun strips types, so no runtime expect on it could fail. What a declining record does
    // to the menus is pinned by the export gate's own tests.
    const declining: DialectSpec = {
      tabType: "kafka",
      offersColumnProfiling: false,
      offersCodeGeneration: false,
      offersCountQuery: false,
      offersSqlExport: false,
    };
    void declining;
    for (const [dialect, spec] of Object.entries(QUERY_DIALECTS)) {
      if (dialect === "milvus" || dialect === "qdrant" || dialect === "oxia") continue;
      expect(Object.hasOwn(spec, "offersSqlExport"), `the ${dialect} record declares offersSqlExport`).toBe(false);
    }
    expect(QUERY_DIALECTS.milvus.offersSqlExport).toBe(false);
    expect(QUERY_DIALECTS.qdrant.offersSqlExport).toBe(false);
    expect(QUERY_DIALECTS.oxia.offersSqlExport).toBe(false);
  });
});

describe("registeredDialect, dialectSpec and declaresDialect", () => {
  test("a declared, registered dialect is found, with its record", () => {
    for (const dialect of ["libredb", "redis", "kafka", "etcd", "milvus", "qdrant", "oxia"] as const) {
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
    for (const dialect of ["a-later-engine", "Redis", ""]) {
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
