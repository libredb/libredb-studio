/**
 * The inputs the dialect registries did not exist for, each answered as before them (vector-family spec 3.8):
 * a tab type a later release saved, and a dialect only a host's own declaration can name.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderCapabilities } from "@/lib/db/types";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import type { QueryTab } from "@/lib/types";

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

describe("a tab restored from storage with a type this release has no record for", () => {
  test("renders in sql, as it did before the registry, and never throws", () => {
    // A later release persists `milvus` tabs; a host on this package version may restore them.
    for (const type of ["milvus", "a-later-engine", "", "constructor", "toString", "__proto__"]) {
      expect(editorLanguageForTabType(type as QueryTab["type"])).toBe("sql");
    }
  });
});

describe("a host declaring a dialect this release has no record for", () => {
  test("gets the tab type its language gives, as before the registry", () => {
    for (const dialect of ["milvus", "constructor", "__proto__"]) {
      const caps = makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });
      expect(resolveTabType(caps)).toBe("mongodb");
      expect(resolveTabType({ ...caps, queryLanguage: "promql" })).toBe("promql");
      expect(resolveTabType({ ...caps, queryLanguage: "sql" })).toBe("sql");
    }
  });
});

describe("a value that is not a string where a tab type or a dialect is expected", () => {
  // A restored tab's type is whatever JSON localStorage holds, and a host's capabilities whatever its code passes,
  // so neither is checked against the union at run time. Before the registries every such value missed every
  // `===` comparison; an own-key lookup would instead coerce it to a key, read `["etcd"]` as `etcd`, and throw on
  // an object whose `toString` is not callable, inside a render.
  const NOT_STRINGS: readonly unknown[] = [{ toString: 0 }, ["etcd"], ["redis"], 42, true, null];

  test("renders a restored tab in sql and never throws", () => {
    for (const type of NOT_STRINGS) {
      expect(editorLanguageForTabType(type as QueryTab["type"])).toBe("sql");
    }
  });

  test("gives the tab type its language gives, as a dialect with no record does", () => {
    for (const dialect of NOT_STRINGS) {
      const caps = makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });
      expect(resolveTabType(caps)).toBe("mongodb");
      expect(resolveTabType({ ...caps, queryLanguage: "sql" })).toBe("sql");
    }
  });
});

describe("capabilities that have not arrived", () => {
  test("open an SQL tab that renders in sql, while provider-meta is in flight or after it failed", () => {
    expect(resolveTabType(undefined)).toBe("sql");
    expect(resolveTabType(null)).toBe("sql");
    expect(editorLanguageForTabType(resolveTabType(undefined))).toBe("sql");
  });
});
