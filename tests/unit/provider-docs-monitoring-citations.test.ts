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
 * SCOPE, deliberately narrow: the whole of every document in `NAMED_CITATIONS`, plus the
 * monitoring seam of the two search docs, plus one file across every provider doc: `factory.ts`
 * is cited by its entry point and never by a line. The rest of `docs/providers/` still cites code
 * by line in quantity — a pre-existing backlog this round did not open — and the two search docs
 * are guarded only inside their monitoring section. Nothing here asserts that the uncovered
 * citations are correct; they are simply not measured yet.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const SEARCH_PROVIDER = "src/lib/db/providers/sql/search/index.ts";
const BASE_PROVIDER = "src/lib/db/base-provider.ts";
const MIGRATION_GENERATOR = "src/lib/schema-diff/migration-generator.ts";
const FACTORY = "src/lib/db/factory.ts";

/** Sorted: `readdirSync` returns filesystem order — green here, red on the next machine. */
const PROVIDER_DOCS = readdirSync(path.join(ROOT, "docs/providers"))
  .filter((entry) => entry.endsWith(".md"))
  .sort()
  .map((entry) => `docs/providers/${entry}`);

/**
 * The docs this round rewrote, the source their prose links to, and the method names that now
 * stand where a line number used to. The list is the point: renaming any of these breaks the
 * doc, and a name that is not declared is caught here rather than by a reader.
 */
const NAMED_CITATIONS = [
  {
    doc: "docs/providers/sqlite.md",
    source: "src/lib/db/providers/sql/sqlite.ts",
    methods: ["getCapabilities", "validate", "connect", "getDatabasePath", "query", "getSchema", "runMaintenance"],
  },
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
  {
    doc: "docs/providers/mysql.md",
    source: "src/lib/db/providers/sql/mysql.ts",
    methods: [
      "getCapabilities",
      "getLabels",
      "validate",
      "buildPoolConfig",
      "buildSSLConfig",
      "query",
      "cancelQuery",
      "beginTransaction",
      "getSchema",
      "runMaintenance",
      "getAllTablesForMaintenance",
    ],
  },
  {
    doc: "docs/providers/oracle.md",
    source: "src/lib/db/providers/sql/oracle.ts",
    methods: [
      "getCapabilities",
      "getLabels",
      "validate",
      "getConnectString",
      "connect",
      "query",
      "cancelQuery",
      "prepareQuery",
      "beginTransaction",
      "getSchema",
      "runMaintenance",
      "getPoolStats",
      "buildTLSAttributes",
    ],
  },
  {
    doc: "docs/providers/mongodb.md",
    source: "src/lib/db/providers/document/mongodb.ts",
    methods: [
      "getCapabilities",
      "getLabels",
      "validate",
      "buildConnectionString",
      "buildTLSOptions",
      "query",
      "parseQuery",
      "serializeDocument",
      "getSchema",
      "runMaintenance",
    ],
  },
  {
    doc: "docs/providers/redis.md",
    source: "src/lib/db/providers/keyvalue/redis.ts",
    methods: [
      "getCapabilities",
      "getLabels",
      "buildTLSOptions",
      "executeRedisCommand",
      "runCommand",
      "formatResult",
      "parseInfoResult",
      "getSchema",
      "getKeyPrefix",
      "calculateHitRatio",
      "getActiveSessions",
    ],
  },
  {
    doc: "docs/providers/postgres.md",
    source: "src/lib/db/providers/sql/postgres.ts",
    methods: [
      "getCapabilities",
      "qualifyMaintenanceTarget",
      "validate",
      "connect",
      "buildSSLConfig",
      "query",
      "cancelQuery",
      "beginTransaction",
      "runMaintenance",
    ],
  },
  {
    doc: "docs/providers/clickhouse.md",
    source: "src/lib/db/providers/sql/clickhouse/index.ts",
    // Tracks the doc, not a hand-picked subset: every `name(` it cites that index.ts declares as
    // a class member, in declaration order. Module-level functions (`resolveConnection`) and
    // inherited SQLBaseProvider members carry no access modifier for `declarationLine` to match.
    methods: [
      "getCapabilities",
      "getLabels",
      "prepareQuery",
      "validate",
      "connect",
      "disconnect",
      "query",
      "mapClickHouseError",
      "getSchema",
      "getSchemaList",
      "getSchemaRelations",
      "getOverview",
      "getPerformanceMetrics",
      "getSlowQueries",
      "getActiveSessions",
      "getTableStats",
      "getIndexStats",
      "getStorageStats",
      "getHealth",
      "runMaintenance",
    ],
  },
  {
    doc: "docs/providers/druid.md",
    source: "src/lib/db/providers/sql/druid/index.ts",
    // Tracks the doc, not a hand-picked subset: every `name(` it cites that index.ts declares as
    // a class member, in declaration order. The doc links the monitoring methods to introspect.ts,
    // where the work is; index.ts declares each as a member that delegates there.
    methods: [
      "getCapabilities",
      "getLabels",
      "prepareQuery",
      "validate",
      "connect",
      "disconnect",
      "query",
      "mapDruidError",
      "getSchema",
      "getOverview",
      "getPerformanceMetrics",
      "getSlowQueries",
      "getIndexStats",
      "getActiveSessions",
      "getTableStats",
      "getStorageStats",
      "getHealth",
      "runMaintenance",
    ],
  },
  {
    doc: "docs/providers/couchbase.md",
    source: "src/lib/db/providers/document/couchbase/index.ts",
    // Same rule as clickhouse: every `name(` the doc cites that index.ts declares as a class
    // member, in declaration order. `degradeTo()` is module-level; the transport, introspection
    // and keyspace names live in their own files.
    methods: [
      "getCapabilities",
      "getLabels",
      "prepareQuery",
      "validate",
      "connect",
      "disconnect",
      "hostFromConnectionString",
      "query",
      "mapCouchbaseError",
      "primaryIndexRemedy",
      "getSchemaList",
      "getSchemaRelations",
      "getSchema",
      "getOverview",
      "getPerformanceMetrics",
      "getSlowQueries",
      "getActiveSessions",
      "getTableStats",
      "getIndexStats",
      "getStorageStats",
      "getHealth",
      "runMaintenance",
      "dispatchMaintenance",
      "requireTarget",
    ],
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

describe("measured aggregate helper docs", () => {
  test("MSSQL and Oracle pin the helper name to its source file", () => {
    for (const doc of ["docs/providers/mssql.md", "docs/providers/oracle.md"]) {
      expect(read(doc)).toContain(
        "`measuredNullableAggregate()` ([`measured-aggregate.ts`](../../src/lib/db/utils/measured-aggregate.ts))",
      );
    }
    expect(read("src/lib/db/utils/measured-aggregate.ts")).toMatch(/^export function measuredNullableAggregate\(/m);
  });
});

describe("provider docs rewritten this round: code cited by name, whole file", () => {
  for (const { doc, source, methods } of NAMED_CITATIONS) {
    test(`${doc} cites no line number anywhere`, () => {
      // `.tsx` too: couchbase.md cited `ConnectionModal.tsx:139`, which `\.ts:` cannot see.
      expect(read(doc)).not.toMatch(/\.tsx?:\d/);
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

  test("provider docs name the factory's entry point rather than a line inside it", () => {
    // Selected on the entry point's NAME, not on the link: fourteen docs link `factory.ts`, and
    // one of them (oracle.md) does so without naming the function — prose it does not owe.
    const docs = PROVIDER_DOCS.filter((doc) => read(doc).includes("`createDatabaseProvider()`"));
    // A derived population can derive to nothing, and a loop over nothing passes; renaming the
    // phrase everywhere used to shed four assertions and stay green (#620).
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(read(doc)).toMatch(
        /`createDatabaseProvider\(\)`\s*\(\[`factory\.ts`\]\(\.\.\/\.\.\/src\/lib\/db\/factory\.ts\)\)/,
      );
    }
    for (const doc of PROVIDER_DOCS) {
      expect(read(doc), `${doc} cites a line inside factory.ts`).not.toMatch(/factory\.ts:\d/);
    }
    expect(read(FACTORY)).toMatch(/^export async function createDatabaseProvider\(/m);
  });
});

const TOP_LEVEL_NAMED_CITATION_DOCS = [
  "docs/AGENT.md",
  "docs/FEATURES.md",
  "docs/ADDING_A_PROVIDER.md",
  "docs/DATABASE_PROVIDERS.md",
  "docs/SECURITY.md",
] as const;

describe("top-level docs: code cited by name, whole file", () => {
  for (const doc of TOP_LEVEL_NAMED_CITATION_DOCS) {
    test(`${doc} cites no TypeScript line number anywhere`, () => {
      expect(read(doc)).not.toMatch(/\.tsx?:\d/);
    });
  }
});

/**
 * A quoted VALUE rots exactly the way a line number does, and nothing above measures it.
 *
 * `docs/providers/mysql.md` presented `slowQueriesEmptyState` as *"... enable the Performance
 * Schema to see them."* — the pre-#463 wording. #463 (e8b0056d) replaced that sentence in
 * `getLabels()` because it named the one cause that never reaches the failure path, and §8 of the
 * same doc says so in the past tense five hundred lines above. The quotation below it was never
 * updated, so one file asserted both that the wording had changed and that it had not. A name
 * survives an insertion above it; a value copied into prose survives nothing.
 *
 * A doc may still quote a superseded value deliberately, in the past tense, to explain why it
 * changed — mysql.md does. So this pins the PRESENCE of the declared value, never the absence of
 * the old one. Whitespace is collapsed on both sides because prose wraps and a string literal
 * does not.
 */
const QUOTED_LABELS = [
  {
    doc: "docs/providers/mysql.md",
    source: "src/lib/db/providers/sql/mysql.ts",
    field: "slowQueriesEmptyState",
  },
];

const collapse = (text: string): string => text.replace(/\s+/g, " ");

describe("provider docs that quote a label value verbatim", () => {
  for (const { doc, source, field } of QUOTED_LABELS) {
    test(`${doc} quotes the ${field} that ${source} declares`, () => {
      const declared = new RegExp(`\\b${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(read(source));
      expect(declared, `${field} is not declared as a string literal in ${source}`).not.toBeNull();
      expect(collapse(read(doc)), `${doc} quotes a ${field} that ${source} no longer declares`).toContain(
        collapse(declared![1]),
      );
    });
  }
});

/**
 * #647: `SQLBaseProvider` has no placeholder logic. The real home is
 * `positionalPlaceholder()` in `src/lib/sql/values.ts`. Docs paraphrased the
 * capability onto the base class (or claimed inheritance); #640's `getPlaceholder`
 * grep missed every paraphrase, and a closed phrasing list missed `mysql.md:31`.
 *
 * Assert on ATTRIBUTION in the sentence that contains a `placeholder(s)` match:
 * denials ("Not in the list…", "no longer has") clear only that sentence, not a
 * ±220-char neighborhood. Pair the negative with a control: if the helper later
 * moves into `sql-base.ts`, the positive assertion goes red and this guard must
 * be rewritten on purpose.
 */
const PLACEHOLDER_ATTRIBUTION_DOCS = [
  "docs/ADDING_A_PROVIDER.md",
  "docs/DATABASE_PROVIDERS.md",
  // Every provider doc, so a sixth site in an unlisted doc cannot be invisible.
  ...PROVIDER_DOCS,
];

/** Broad: any "placeholder" / "placeholders" — denials are sentence-scoped. */
const PLACEHOLDER_CAPABILITY_SOURCE = String.raw`\bplaceholders?\b`;

/** Sentence containing `matchIndex` in already-collapsed prose (`.!?` boundaries). */
const sentenceAt = (collapsed: string, matchIndex: number): string => {
  let start = 0;
  for (const boundary of collapsed.slice(0, matchIndex).matchAll(/[.!?]\s+/g)) {
    start = boundary.index! + boundary[0].length;
  }
  const rest = collapsed.slice(matchIndex);
  const endRel = /[.!?](?:\s|$)/.exec(rest);
  const end = endRel ? matchIndex + endRel.index! + 1 : collapsed.length;
  return collapsed.slice(start, end);
};

/** SQLBaseProvider "provides / adds / gives for free" sections that must not list positionalPlaceholder. */
const SQLBASE_PROVIDES_SECTIONS = [
  {
    doc: "docs/ADDING_A_PROVIDER.md",
    heading: /### What SQLBaseProvider adds[\s\S]*?(?=\n### |\n## )/,
    label: "### What SQLBaseProvider adds",
  },
  {
    doc: "docs/providers/postgres.md",
    heading: /### 2\.2 What `SQLBaseProvider` provides[\s\S]*?(?=\n### |\n## )/,
    label: "### 2.2 What `SQLBaseProvider` provides",
  },
] as const;

describe("docs do not credit SQLBaseProvider with placeholders (#647)", () => {
  for (const doc of PLACEHOLDER_ATTRIBUTION_DOCS) {
    test(`${doc} does not credit SQLBaseProvider / inheritance with placeholders`, () => {
      const collapsed = collapse(read(doc));
      // Fresh /g regex per test — a shared global keeps lastIndex across cases.
      for (const match of collapsed.matchAll(new RegExp(PLACEHOLDER_CAPABILITY_SOURCE, "gi"))) {
        const window = sentenceAt(collapsed, match.index!);
        const credits =
          /SQLBaseProvider/i.test(window) ||
          (/\binherited\b/i.test(window) && !/\b(?:not|rather than)\s+inherited\b/i.test(window));
        const denies = /\bno longer has\b|\bnot in the list\b/i.test(window);
        expect(
          credits && !denies,
          `${doc} credits SQLBaseProvider/inheritance with "${match[0]}" in: …${window.slice(0, 160)}…`,
        ).toBe(false);
      }
    });
  }

  for (const { doc, heading, label } of SQLBASE_PROVIDES_SECTIONS) {
    test(`${doc} does not list positionalPlaceholder under ${label}`, () => {
      const text = read(doc);
      // Stop at the next heading (### or ##) so a sibling placeholders section is excluded.
      const section = heading.exec(text)?.[0];
      expect(section, `expected ${label} section in ${doc}`).toBeDefined();
      expect(section!, `positionalPlaceholder must not sit under ${label}`).not.toMatch(/positionalPlaceholder/);
    });
  }

  test("positionalPlaceholder is declared in values.ts; sql-base declares no placeholder member", () => {
    expect(read("src/lib/sql/values.ts")).toMatch(/^export function positionalPlaceholder\(/m);
    expect(read("src/lib/db/providers/sql/sql-base.ts")).not.toMatch(/placeholder/i);
  });
});
