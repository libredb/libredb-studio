import { describe, expect, test } from "bun:test";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import type { ProviderCapabilities } from "@/lib/db/types";

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: [],
    supportsConnectionString: true,
    schemaRefreshPattern: "CREATE|ALTER|DROP",
    defaultPort: 5432,
    ...overrides,
  } as ProviderCapabilities;
}

describe("resolveTabType", () => {
  test("SQL providers get a sql tab", () => {
    expect(resolveTabType(makeCaps())).toBe("sql");
  });

  test("MongoDB (queryLanguage json, no dialect) gets a mongodb tab", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "json" }))).toBe("mongodb");
  });

  test("LibreDB gets a libredb tab", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "json", queryDialect: "libredb" }))).toBe("libredb");
  });

  test("Redis gets a redis tab even though it declares queryLanguage json (#427)", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe("redis");
  });

  test("missing capabilities fall back to sql", () => {
    expect(resolveTabType(undefined)).toBe("sql");
    expect(resolveTabType(null)).toBe("sql");
  });
});

describe("editorLanguageForTabType", () => {
  test("maps every tab type to its Monaco language id", () => {
    expect(editorLanguageForTabType("sql")).toBe("sql");
    expect(editorLanguageForTabType("mongodb")).toBe("json");
    expect(editorLanguageForTabType("libredb")).toBe("libredb");
    expect(editorLanguageForTabType("redis")).toBe("redis");
  });
});
