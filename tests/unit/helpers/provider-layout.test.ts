/**
 * The resolver that tells a test where a type-id's code, doc and integration test are, in the legacy layout or as a
 * workspace package (CLAUDE.md, the provider triad under "Rules & patterns").
 *
 * The legacy cases read the repository as it is; every refusal is planted in a throwaway root, because the
 * repository holds none of them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { plantedRoot, REPOSITORY_ROOT, removePlantedRoot } from "../../helpers/planted-package";
import { providerTriad, providerTriadViolations } from "../../helpers/provider-layout";

const CODE = "export {};\n";
const DOC = "# Placeholder\n";
const PROVIDERS = ["src", "lib", "db", "providers"] as const;

const roots: string[] = [];

function root(files: Readonly<Record<string, string>>): string {
  const made = plantedRoot({ copy: [], workspaces: true, linkNodeModules: false, files });
  roots.push(made);
  return made;
}

afterEach(() => {
  for (const made of roots.splice(0)) removePlantedRoot(made);
});

function manifest(name: string): string {
  return `${JSON.stringify({ name: `@libredb/${name}`, private: true })}\n`;
}

/** A complete provider package for `type`, with no legacy file. */
function providerPackage(type: string): Record<string, string> {
  const directory = `packages/provider-${type}`;
  return {
    [`${directory}/package.json`]: manifest(`provider-${type}`),
    [`${directory}/src/index.ts`]: CODE,
    [`${directory}/docs/${type}.md`]: DOC,
    [`${directory}/tests/integration/${type}-provider.test.ts`]: CODE,
  };
}

/** A complete legacy triad for `type` whose code is the file `code`, without the agent leg. */
function legacyTriad(type: string, code: string): Record<string, string> {
  return {
    [code]: CODE,
    [`docs/providers/${type}.md`]: DOC,
    [`tests/integration/db/${type}-provider.test.ts`]: CODE,
  };
}

/** The agent leg's two core files for `type` speaking `language`. */
function agentLeg(type: string, language: string): Record<string, string> {
  return {
    [`src/lib/agent/languages/${language}/engines/${type}.ts`]: CODE,
    [`src/lib/agent/languages/${language}/engines/client.ts`]: CODE,
  };
}

function without(files: Record<string, string>, ...removed: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([file]) => !removed.includes(file)));
}

/** The message `providerTriad` throws, so each case can match its substrings. */
function refusal(made: string, type: Parameters<typeof providerTriad>[1]): string {
  try {
    providerTriad(made, type);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`providerTriad(${type}) resolved, but this case expects a refusal`);
}

const BIGQUERY_LEGACY_CODE = "src/lib/db/providers/sql/bigquery/index.ts";

describe("the legacy layout", () => {
  test("a flat provider file", () => {
    expect(providerTriad(REPOSITORY_ROOT, "postgres").code).toBe(
      path.join(REPOSITORY_ROOT, ...PROVIDERS, "sql", "postgres.ts"),
    );
  });

  test("a provider directory with index.ts", () => {
    expect(providerTriad(REPOSITORY_ROOT, "bigquery").code).toBe(
      path.join(REPOSITORY_ROOT, ...PROVIDERS, "sql", "bigquery"),
    );
  });

  test("a directory PROVIDER_DIRECTORY_MAP maps to two type-ids", () => {
    const search = path.join(REPOSITORY_ROOT, ...PROVIDERS, "sql", "search");
    expect({
      elasticsearch: providerTriad(REPOSITORY_ROOT, "elasticsearch").code,
      opensearch: providerTriad(REPOSITORY_ROOT, "opensearch").code,
      influxdb3: providerTriad(REPOSITORY_ROOT, "influxdb3").code,
    }).toEqual({
      elasticsearch: search,
      opensearch: search,
      influxdb3: path.join(REPOSITORY_ROOT, ...PROVIDERS, "timeseries", "influxdb"),
    });
  });

  test("influxdb reaches one directory by both the map and the rule", () => {
    expect(providerTriad(REPOSITORY_ROOT, "influxdb").code).toBe(
      path.join(REPOSITORY_ROOT, ...PROVIDERS, "timeseries", "influxdb"),
    );
  });

  test("the doc, the integration test and the agent leg", () => {
    const engines = path.join(REPOSITORY_ROOT, "src", "lib", "agent", "languages", "sql", "engines");
    expect(providerTriad(REPOSITORY_ROOT, "postgres")).toEqual({
      type: "postgres",
      layout: "legacy",
      code: path.join(REPOSITORY_ROOT, ...PROVIDERS, "sql", "postgres.ts"),
      doc: path.join(REPOSITORY_ROOT, "docs", "providers", "postgres.md"),
      integrationTest: path.join(REPOSITORY_ROOT, "tests", "integration", "db", "postgres-provider.test.ts"),
      agent: { overlay: path.join(engines, "postgres.ts"), client: path.join(engines, "client.ts") },
    });
    expect(providerTriad(REPOSITORY_ROOT, "bigquery").agent).toBeNull();
  });

  test.each([
    {
      label: "the same family",
      files: legacyTriad("bigquery", "src/lib/db/providers/sql/bigquery.ts"),
      extra: BIGQUERY_LEGACY_CODE,
      named: ["src/lib/db/providers/sql/bigquery.ts", "src/lib/db/providers/sql/bigquery"],
    },
    {
      label: "two families",
      files: legacyTriad("bigquery", BIGQUERY_LEGACY_CODE),
      extra: "src/lib/db/providers/document/bigquery/index.ts",
      named: ["src/lib/db/providers/sql/bigquery", "src/lib/db/providers/document/bigquery"],
    },
  ])("refuses code in two places: $label", ({ files, extra, named }) => {
    const message = refusal(root({ ...files, [extra]: CODE }), "bigquery");

    expect(message).toContain("more than one place");
    for (const location of named) expect(message).toContain(location);
  });
});

describe("the package layout", () => {
  test("resolves a complete provider package", () => {
    const made = root(providerPackage("bigquery"));
    const directory = path.join(made, "packages", "provider-bigquery");

    expect(providerTriad(made, "bigquery")).toEqual({
      type: "bigquery",
      layout: "package",
      code: path.join(directory, "src"),
      doc: path.join(directory, "docs", "bigquery.md"),
      integrationTest: path.join(directory, "tests", "integration", "bigquery-provider.test.ts"),
      agent: null,
    });
  });

  test("refuses a type-id whose legacy doc remains beside its package", () => {
    const message = refusal(root({ ...providerPackage("bigquery"), "docs/providers/bigquery.md": DOC }), "bigquery");

    for (const part of ["bigquery", "in both layouts", "docs/providers/bigquery.md"]) expect(message).toContain(part);
  });

  test("names every legacy leg that remains beside the package", () => {
    const made = root({ ...providerPackage("bigquery"), ...legacyTriad("bigquery", BIGQUERY_LEGACY_CODE) });
    const message = refusal(made, "bigquery");

    expect(message).toContain("in both layouts");
    for (const leg of [
      "src/lib/db/providers/sql/bigquery",
      "docs/providers/bigquery.md",
      "tests/integration/db/bigquery-provider.test.ts",
    ]) {
      expect(message).toContain(leg);
    }
  });
});

describe("missing legs", () => {
  const pkg = providerPackage("bigquery");
  const legacy = legacyTriad("bigquery", BIGQUERY_LEGACY_CODE);

  test.each([
    {
      label: "a package without its doc",
      files: without(pkg, "packages/provider-bigquery/docs/bigquery.md"),
      named: ["packages/provider-bigquery/docs/bigquery.md"],
    },
    {
      label: "a package without its integration test",
      files: without(pkg, "packages/provider-bigquery/tests/integration/bigquery-provider.test.ts"),
      named: ["packages/provider-bigquery/tests/integration/bigquery-provider.test.ts"],
    },
    {
      label: "a package without its src directory",
      files: without(pkg, "packages/provider-bigquery/src/index.ts"),
      named: ["packages/provider-bigquery/src"],
    },
    {
      label: "a legacy provider without its integration test",
      files: without(legacy, "tests/integration/db/bigquery-provider.test.ts"),
      named: ["tests/integration/db/bigquery-provider.test.ts"],
    },
    {
      label: "a legacy provider without its doc",
      files: without(legacy, "docs/providers/bigquery.md"),
      named: ["docs/providers/bigquery.md"],
    },
    {
      label: "a legacy provider without its code",
      files: without(legacy, BIGQUERY_LEGACY_CODE),
      named: [
        "has no code",
        "src/lib/db/providers/<family>/bigquery.ts",
        "src/lib/db/providers/<family>/bigquery/index.ts",
        "tests/helpers/provider-directory-map.ts",
      ],
    },
    {
      label: "an empty root",
      files: {},
      named: ["has no code", "docs/providers/bigquery.md", "tests/integration/db/bigquery-provider.test.ts"],
    },
  ])("$label", ({ files, named }) => {
    const message = refusal(root(files), "bigquery");

    for (const part of named) expect(message).toContain(part);
  });
});

describe("a package serves one type-id", () => {
  test("refuses a provider package that holds another type-id's doc", () => {
    const made = root({
      ...providerPackage("elasticsearch"),
      "packages/provider-elasticsearch/docs/opensearch.md": DOC,
      ...legacyTriad("opensearch", "src/lib/db/providers/sql/search/index.ts"),
      ...agentLeg("opensearch", "sql"),
    });
    const message = refusal(made, "opensearch");

    for (const part of [
      "packages/provider-elasticsearch",
      "docs/opensearch.md",
      "serves only the type-id its directory names",
    ]) {
      expect(message).toContain(part);
    }
  });

  test("refuses a package named for no type-id that holds a type-id's integration test", () => {
    const made = root({
      "packages/provider-search/package.json": manifest("provider-search"),
      "packages/provider-search/src/index.ts": CODE,
      "packages/provider-search/tests/integration/elasticsearch-provider.test.ts": CODE,
    });
    const message = refusal(made, "elasticsearch");

    for (const part of ["packages/provider-search", "tests/integration/elasticsearch-provider.test.ts"]) {
      expect(message).toContain(part);
    }
  });

  test("a package that holds no type-id's doc or test claims nothing", () => {
    const made = root({
      "packages/provider-sdk/package.json": manifest("provider-sdk"),
      "packages/provider-sdk/src/index.ts": CODE,
      "packages/provider-sdk/docs/README.md": DOC,
      ...legacyTriad("bigquery", BIGQUERY_LEGACY_CODE),
    });

    expect(providerTriad(made, "bigquery").layout).toBe("legacy");
  });
});

describe("the agent leg", () => {
  const kafka = legacyTriad("kafka", "src/lib/db/providers/stream/kafka/index.ts");
  const overlay = "src/lib/agent/languages/kafkaread/engines/kafka.ts";
  const client = "src/lib/agent/languages/kafkaread/engines/client.ts";

  test("refuses a legacy provider without its overlay module", () => {
    expect(refusal(root({ ...kafka, [client]: CODE }), "kafka")).toContain(overlay);
  });

  test("refuses a legacy provider without its language's client overlays module", () => {
    expect(refusal(root({ ...kafka, [overlay]: CODE }), "kafka")).toContain(client);
  });

  test("resolves a legacy provider with both", () => {
    const made = root({ ...kafka, ...agentLeg("kafka", "kafkaread") });
    const engines = path.join(made, "src", "lib", "agent", "languages", "kafkaread", "engines");

    expect(providerTriad(made, "kafka").agent).toEqual({
      overlay: path.join(engines, "kafka.ts"),
      client: path.join(engines, "client.ts"),
    });
  });

  test("refuses a provider package whose type-id speaks a statement language", () => {
    const message = refusal(root({ ...providerPackage("kafka"), ...agentLeg("kafka", "kafkaread") }), "kafka");

    for (const part of ["kafka", "kafkaread", "no place for its agent leg"]) expect(message).toContain(part);
  });
});

describe("providerTriadViolations", () => {
  test("lists each type-id's problems", () => {
    const made = root({
      ...without(legacyTriad("bigquery", BIGQUERY_LEGACY_CODE), "docs/providers/bigquery.md"),
      ...without(
        legacyTriad("snowflake", "src/lib/db/providers/sql/snowflake/index.ts"),
        "tests/integration/db/snowflake-provider.test.ts",
      ),
    });
    const violations = providerTriadViolations(made, ["bigquery", "snowflake"]);

    expect(violations).toEqual([
      expect.stringContaining("docs/providers/bigquery.md"),
      expect.stringContaining("tests/integration/db/snowflake-provider.test.ts"),
    ]);
  });

  test("is empty when every type-id resolves", () => {
    const made = root({
      ...legacyTriad("bigquery", BIGQUERY_LEGACY_CODE),
      ...legacyTriad("snowflake", "src/lib/db/providers/sql/snowflake/index.ts"),
    });

    expect(providerTriadViolations(made, ["bigquery", "snowflake"])).toEqual([]);
  });
});
