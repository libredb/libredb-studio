/**
 * The provider docs cite code by NAME, not by line.
 *
 * A line number hand-copied into prose has nothing measuring it, so it is true only until the
 * next insertion above it, and nothing goes red when it stops being true.
 *
 * `docs/providers/elasticsearch.md` and `docs/providers/opensearch.md` carried a
 * monitoring-seam table whose eight rows each pinned a method to a line number in
 * `src/lib/db/providers/sql/search/index.ts`. All eight were written in one commit —
 * `git log -S"index.ts:811" -- docs/providers/elasticsearch.md` returns 25712e68 (#429) alone —
 * as 751/811/831/844/860/873/884/898. They were never right: in that same commit the eight
 * declarations sat at 808/868/888/901/917/930/941/955, a uniform +57, so the numbers had been
 * read off the file before something above them grew and were shipped stale. Today the offset is
 * a uniform +65. Being wrong by a constant is what let this survive: the rows stayed in
 * ascending order and went on reading as a consistent, ordered, plausible list, so there was no
 * internal contradiction for a reader to notice and no gate measuring the numbers at all.
 *
 * `docs/providers/redis.md` shows what hand-correcting such a number buys. #89 wrote
 * `base-provider.ts:102` for `getMonitoringData()`, true at that commit; #122 corrected it to
 * `:99`, true at that commit; it has since rotted a second time. A method name is greppable and
 * survives an insertion above it, so it needs no correction round at all.
 *
 * These tests therefore pin the policy rather than any coordinate: the seam rows name real
 * declarations, they are listed in the order the source declares them, both search docs name the
 * same eight, and the docs in scope carry no `:<line>` suffix.
 *
 * SCOPE, deliberately narrow: the whole of `docs/providers/mssql.md` and
 * `docs/providers/trino.md`, plus the monitoring seam of the two search docs and the one
 * `base-provider.ts` citation in `docs/providers/redis.md`. The rest of `docs/providers/` still
 * cites code by line in quantity — a pre-existing backlog this round did not open — and the two
 * search docs are guarded only inside their monitoring section. Nothing here asserts that the
 * uncovered citations are correct; they are simply not measured yet.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const SEARCH_PROVIDER = "src/lib/db/providers/sql/search/index.ts";
const BASE_PROVIDER = "src/lib/db/base-provider.ts";
const MIGRATION_GENERATOR = "src/lib/schema-diff/migration-generator.ts";
const FACTORY = "src/lib/db/factory.ts";

/**
 * The docs this round rewrote, the source their prose links to, and the method names that now
 * stand where a line number used to. The list is the point: renaming any of these breaks the
 * doc, and a name that is not declared is caught here rather than by a reader.
 */
const NAMED_CITATIONS = [
  {
    doc: "docs/providers/mssql.md",
    source: "src/lib/db/providers/sql/mssql.ts",
    methods: [
      "getCapabilities",
      "getLabels",
      "validate",
      "buildConfig",
      "query",
      "cancelQuery",
      "prepareQuery",
      "beginTransaction",
      "queryInTransaction",
      "getSchema",
      "runMaintenance",
      "getPoolStats",
    ],
  },
  {
    doc: "docs/providers/trino.md",
    source: "src/lib/db/providers/sql/trino/index.ts",
    methods: ["getCapabilities", "getLabels"],
  },
] as const;

const SEARCH_DOCS = ["docs/providers/elasticsearch.md", "docs/providers/opensearch.md"] as const;

/** The `## 7. Monitoring & health` block, up to the next top-level section. */
const monitoringSection = (doc: string): string => {
  const start = doc.indexOf("## 7. Monitoring & health");
  expect(start).toBeGreaterThan(-1);
  const rest = doc.slice(start);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
};

/** The first column of the `| Method | Source | Mapping |` table, in document order. */
const seamTableMethods = (section: string): string[] => {
  const header = section.indexOf("| Method | Source | Mapping |");
  expect(header).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of section.slice(header).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const cell = line.split("|")[1].trim();
    const named = /^`([A-Za-z]+)\(\)`$/.exec(cell);
    expect(named, `seam row cites something other than a bare method name: ${cell}`).not.toBeNull();
    rows.push((named as RegExpExecArray)[1]);
  }
  return rows;
};

/** Line number of a method's declaration in a provider source, or -1. */
const declarationLine = (source: string, method: string): number =>
  source.split("\n").findIndex((line) => new RegExp(`^\\s*(public|protected|private).*\\b${method}\\(`).test(line));

describe("search provider docs: the monitoring seam table", () => {
  const provider = read(SEARCH_PROVIDER);

  test("both docs name the same eight methods", () => {
    const [elasticsearch, opensearch] = SEARCH_DOCS.map((doc) => seamTableMethods(monitoringSection(read(doc))));
    expect(elasticsearch).toEqual(opensearch);
    expect(elasticsearch).toHaveLength(8);
  });

  for (const doc of SEARCH_DOCS) {
    test(`${doc} rows name real declarations, in the order the source declares them`, () => {
      const methods = seamTableMethods(monitoringSection(read(doc)));
      const lines = methods.map((method) => {
        const line = declarationLine(provider, method);
        expect(line, `${method}() is not declared in ${SEARCH_PROVIDER}`).toBeGreaterThan(-1);
        return line;
      });
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
    });

    test(`${doc} cites no line number in the monitoring section`, () => {
      expect(monitoringSection(read(doc))).not.toMatch(/\.ts:\d/);
    });

    test(`${doc} names runMaintenance() and the refusal table rather than their lines`, () => {
      const text = read(doc);
      expect(text).toContain("`runMaintenance(type)` ([`search/index.ts`]");
      // The prose wraps, so the name and the un-numbered link are pinned separately.
      expect(text).toContain("`NO_COLUMN_MODIFICATION` table in");
      expect(text).toContain("[`migration-generator.ts`](../../src/lib/schema-diff/migration-generator.ts)");
      expect(text).not.toMatch(/migration-generator\.ts:\d/);
    });
  }

  test("NO_COLUMN_MODIFICATION is the real name of the refusal table", () => {
    expect(read(MIGRATION_GENERATOR)).toMatch(/^const NO_COLUMN_MODIFICATION\b/m);
  });
});

describe("redis provider doc", () => {
  test("names getMonitoringData() rather than a line in base-provider.ts", () => {
    const text = read("docs/providers/redis.md");
    expect(text).toContain("`getMonitoringData()` from\n[`base-provider.ts`](../../src/lib/db/base-provider.ts)");
    expect(text).not.toMatch(/base-provider\.ts:\d/);
    expect(declarationLine(read(BASE_PROVIDER), "getMonitoringData")).toBeGreaterThan(-1);
  });
});

describe("provider docs rewritten this round: code cited by name, whole file", () => {
  for (const { doc, source, methods } of NAMED_CITATIONS) {
    test(`${doc} cites no line number anywhere`, () => {
      expect(read(doc)).not.toMatch(/\.ts:\d/);
    });

    test(`${doc} names methods that ${source} really declares`, () => {
      const text = read(doc);
      const provider = read(source);
      for (const method of methods) {
        expect(text.includes(`\`${method}(`), `${doc} no longer names ${method}()`).toBe(true);
        expect(declarationLine(provider, method), `${method}() is not declared in ${source}`).toBeGreaterThan(-1);
      }
    });
  }

  test("mssql.md names the factory's entry point rather than a line inside it", () => {
    expect(read("docs/providers/mssql.md")).toContain(
      "`createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts))",
    );
    expect(read(FACTORY)).toMatch(/^export async function createDatabaseProvider\(/m);
  });
});
