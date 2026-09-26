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

  test("Prometheus (queryLanguage promql, no dialect) gets a promql tab, not the SQL fallback (#1085)", () => {
    expect(resolveTabType(makeCaps({ queryLanguage: "promql" }))).toBe("promql");
  });

  test("Kafka gets a kafka tab, not the MongoDB one its queryLanguage json would give (#1088)", () => {
    // The dialect is read before the language: a Kafka read request is JSON of this product's own
    // schema, never a MongoDB document.
    expect(resolveTabType(makeCaps({ queryLanguage: "json", queryDialect: "kafka" }))).toBe("kafka");
    // The control: the same declaration with the dialect removed is MongoDB's.
    expect(resolveTabType(makeCaps({ queryLanguage: "json" }))).toBe("mongodb");
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
    expect(editorLanguageForTabType("promql")).toBe("promql");
    expect(editorLanguageForTabType("kafka")).toBe("json");
  });

  test("a Kafka tab renders in Monaco's built-in json mode, and no language of its own (#1088)", () => {
    // Its read request is JSON, so it takes the mode a MongoDB tab takes rather than the SQL
    // fallback, and no Monaco language is registered for it (#1088, section 3.3).
    expect(editorLanguageForTabType(resolveTabType(makeCaps({ queryLanguage: "json", queryDialect: "kafka" })))).toBe(
      "json",
    );
  });
});
