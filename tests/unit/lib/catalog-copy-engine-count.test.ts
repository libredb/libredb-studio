/**
 * The accuracy gate for the engine COUNT in outward-facing catalog copy (#D47).
 *
 * Nine files outside `src/` name the engine set by hand, and until this test nothing
 * counted them: `scripts/readme-check.mjs` locates the engine table in the three
 * READMEs and `chart:check` pins a version across files, but a storefront listing was
 * only ever corrected by somebody noticing. Measured on the DuckDB registration branch,
 * every one of these nine was a full engine behind two weeks after libSQL shipped
 * (#511), and DuckDB was the second engine in a row to walk into it.
 *
 * The rule is not "every file names every engine" - three of the nine deliberately
 * abridge, because a numeral there goes stale the day the next engine lands (#445). It
 * is:
 *
 * 1. a numeral qualifying the word "engines" must equal `EXTERNAL_DATABASE_TYPES.length`;
 * 2. where that numeral introduces a LIST, the list must name every one of them, by the
 *    `DB_UI_CONFIG` labels rather than by a copy of the names kept here.
 *
 * A numeral that qualifies a NARROWER noun ("the two search engines") is not a claim
 * about the product's set and is left alone, and an explicitly abridged list ("and
 * more", "among them", "from X ... to Y") is checked on its numeral only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * The nine files that publish the engine set outward. Each is copy somebody else's
 * catalog renders, so nobody in this repo reads it again once it is submitted.
 *
 * `from`/`to` cut away editorial matter, and only `CATALOG_LISTING.md` has any: its
 * accuracy-gate blockquote and its outstanding-corrections table exist to NAME stale
 * numerals (including a quote of the count the LIVE listing still publishes), so a
 * count check over the whole file would fail on the note that warns about the count.
 * The same slice is used by `tests/unit/marketplace-copy.test.ts`.
 */
const COPY_FILES: ReadonlyArray<{ path: string; from?: string; to?: string }> = [
  { path: "packaging/linux/nfpm.yaml" },
  { path: "packaging/winget/LibreDB.Studio.locale.en-US.yaml.tmpl" },
  { path: "packaging/chocolatey/libredb-studio.nuspec.tmpl" },
  { path: "desktop/src-tauri/tauri.conf.json" },
  { path: "deploy/caprover/libredb-studio.yml" },
  { path: "deploy/railway/template.json" },
  { path: "deploy/azure/listing/listing-fields.md" },
  { path: "deploy/azure/listing/description.html" },
  { path: "deploy/rancher/CATALOG_LISTING.md", from: "## Short description", to: "## Outstanding corrections" },
];

const NUMERAL_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/**
 * Only "N engines" and "N database engines" count. Any other qualifier narrows the noun
 * to a subset of the product - "the two search engines accept no mutation" is a true
 * sentence about Elasticsearch and OpenSearch, not a stale total.
 */
const ENGINE_COUNT_RE = new RegExp(
  `\\b(\\d{1,3}|${Object.keys(NUMERAL_WORDS).join("|")})\\s+(?:database\\s+)?engines\\b`,
  "gi",
);

/** A list that says so is checked on its numeral only (#445). */
const ABRIDGED_RE = /\band more\b|\bamong them\b|\bfrom\b[^.]*?\bto\b/i;

/**
 * The name each engine is searched for. Taken from the `DB_UI_CONFIG` label with a
 * leading "Apache " dropped, because the copy is inconsistent about it in both
 * directions - the label says "Trino" where the listings say "Apache Trino", and says
 * "Apache Druid" where one listing says "Druid" - and because the bare product name is
 * what survives every spelling a listing uses for a family ("MySQL/MariaDB/TiDB",
 * "Microsoft SQL Server", "libSQL/Turso").
 */
const ENGINE_NAMES: ReadonlyArray<{ type: string; name: string }> = EXTERNAL_DATABASE_TYPES.map((type) => ({
  type,
  name: DB_UI_CONFIG[type].label.replace(/^Apache /, ""),
}));

/**
 * Where the sentence (or the markdown bullet, or the `<li>`) holding a numeral ends.
 * The list has to be bounded or the count would sweep up the engine names in the copy
 * below it - every listing names a subset again when it describes inline editing or the
 * explain-capable set.
 */
const SEGMENT_END_RE = /\.\s|\n\s*\n|\n\s*[-*]\s/;

/**
 * Markup out, block boundaries kept. The Azure description is HTML and puts a
 * `</strong>` between the numeral and its list, which ended the segment on a tag rather
 * than on the sentence and left the longest exhaustive list in the nine unchecked -
 * measured while writing this test.
 */
function withoutMarkup(text: string): string {
  const withBlockBreaks = text.replace(/<\/(?:li|p|ul|ol|h[1-6])>|<br\s*\/?>/gi, "\n\n");

  // Stripped to a FIXED POINT rather than in one pass. A single `replace` can splice two
  // surviving fragments into a fresh tag - `<<p>p>` becomes `<p>` - which is what CodeQL's
  // `js/incomplete-multi-character-sanitization` rule reports, and it reported it here.
  // Nothing this function returns is ever rendered: the output is searched for engine names
  // and counted inside this test. But the rule is right about the behaviour, and a stripper
  // that can reintroduce a tag is wrong for counting too, because it would leave a tag NAME
  // in the text being searched. `[^<>]*` rather than `[^>]*` so the inner tag is the match.
  let stripped = withBlockBreaks;
  for (let previous = ""; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(/<[^<>]*>/g, "");
  }
  return stripped;
}

function listSegment(text: string, offset: number): string {
  const rest = text.slice(offset);
  const end = SEGMENT_END_RE.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

/** Every problem the copy in `text` publishes, named so the fix is obvious. */
function engineCountProblems(text: string, label: string): string[] {
  const expected = EXTERNAL_DATABASE_TYPES.length;
  const problems: string[] = [];

  for (const match of text.matchAll(ENGINE_COUNT_RE)) {
    const written = match[1].toLowerCase();
    const value = NUMERAL_WORDS[written] ?? Number(written);
    if (value !== expected) {
      problems.push(`${label}: "${match[0]}" publishes ${value}, and there are ${expected}`);
      continue;
    }

    const segment = listSegment(text, (match.index ?? 0) + match[0].length);
    const named = ENGINE_NAMES.filter(({ name }) => segment.includes(name));
    // Two names is what separates a list from a sentence that happens to mention an
    // engine; below that there is nothing to count.
    if (named.length < 2 || ABRIDGED_RE.test(segment)) continue;

    if (named.length !== expected) {
      const missing = ENGINE_NAMES.filter(({ name }) => !segment.includes(name)).map(({ type }) => type);
      problems.push(`${label}: the list after "${match[0]}" names ${named.length}, missing ${missing.join(", ")}`);
    }
  }

  return problems;
}

function copyOf(entry: (typeof COPY_FILES)[number]): string {
  const content = readFileSync(join(REPO_ROOT, entry.path), "utf8");
  if (!entry.from) return withoutMarkup(content);
  const from = content.indexOf(entry.from);
  const to = entry.to ? content.indexOf(entry.to) : content.length;
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return withoutMarkup(content.slice(from, to));
}

describe("outward-facing catalog copy counts the engines the registry ships", () => {
  test.each(COPY_FILES.map((entry) => [entry.path, entry] as const))("%s", (path, entry) => {
    expect(engineCountProblems(copyOf(entry), path)).toEqual([]);
  });

  // The walk is only worth as much as the matches it finds: a regex that matched
  // nothing would pass every file above. Both halves of the rule must fire on the real
  // copy, not only on the fixtures below.
  test("the walk actually finds numerals and lists to check", () => {
    const segments = COPY_FILES.flatMap((entry) => {
      const text = copyOf(entry);
      return [...text.matchAll(ENGINE_COUNT_RE)].map((match) =>
        listSegment(text, (match.index ?? 0) + match[0].length),
      );
    });

    // Nine numerals and seven counted lists on this revision.
    expect(segments.length).toBeGreaterThanOrEqual(8);
    const counted = segments.filter(
      (segment) => !ABRIDGED_RE.test(segment) && ENGINE_NAMES.filter(({ name }) => segment.includes(name)).length >= 2,
    );
    expect(counted.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the markup stripper cannot reintroduce what it removes", () => {
  test("a spliced tag is stripped, not left as a bare tag name", () => {
    // One `replace` pass turns `<<p>p>` into `p>` - it removes the inner tag and leaves the
    // outer fragments touching. For this gate that is a counting fault, not a rendering one:
    // a tag NAME surviving into the text is a token the engine-name search then reads. The
    // one-pass form is what CodeQL flagged as `js/incomplete-multi-character-sanitization`.
    expect(withoutMarkup("<<p>p>PostgreSQL")).toBe("PostgreSQL");
    expect(withoutMarkup("<<span>span>MySQL")).toBe("MySQL");
  });

  test("an ordinary tag is still stripped once", () => {
    // Control: the fixed-point loop must not change the plain case it was already right about.
    expect(withoutMarkup("<p>PostgreSQL</p>")).toBe("PostgreSQL\n\n");
    expect(withoutMarkup("no markup at all")).toBe("no markup at all");
  });
});

describe("the gate fails the copy it exists to catch", () => {
  const fullList = ENGINE_NAMES.map(({ name }) => name).join(", ");
  const expected = EXTERNAL_DATABASE_TYPES.length;

  test("a list naming one engine too few is refused", () => {
    // The exact shape D47 measured nine times: the numeral was corrected and one name
    // was not, or the other way round.
    const short = ENGINE_NAMES.slice(0, -1)
      .map(({ name }) => name)
      .join(", ");
    const problems = engineCountProblems(`SQL IDE for ${expected} engines - ${short} - with AI.`, "fixture");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ENGINE_NAMES[ENGINE_NAMES.length - 1].type);
  });

  test("a stale numeral in front of a complete list is refused", () => {
    const problems = engineCountProblems(`SQL IDE for ${expected - 1} engines - ${fullList} - with AI.`, "fixture");

    expect(problems).toEqual([
      `fixture: "${expected - 1} engines" publishes ${expected - 1}, and there are ${expected}`,
    ]);
  });

  test("an English numeral is read as well as a digit", () => {
    expect(engineCountProblems("Query fourteen engines from your browser.", "fixture")).toHaveLength(1);
    expect(engineCountProblems(`Sixteen database engines in one IDE: ${fullList}`, "fixture")).toEqual([]);
  });

  test("a deliberately abridged list is checked on its numeral only", () => {
    // winget's and chocolatey's summaries, and two Azure fields, name a few engines and
    // stop - deliberately, so that no numeral goes stale (#445).
    expect(
      engineCountProblems(`SQL IDE for ${expected} engines: PostgreSQL, MySQL, Redis and more`, "fixture"),
    ).toEqual([]);
    expect(
      engineCountProblems(`Connect to ${expected} engines, from PostgreSQL and MySQL to Apache Cassandra.`, "fixture"),
    ).toEqual([]);
  });

  test("a numeral qualifying a narrower noun is not a claim about the set", () => {
    // A real sentence from the Rancher listing's long description.
    expect(engineCountProblems("the two search engines accept no mutation at all", "fixture")).toEqual([]);
  });

  test("copy that publishes no numeral at all is left alone", () => {
    // The winget and chocolatey summaries name engines without counting them.
    expect(engineCountProblems("Web-based SQL IDE for SQL, NoSQL, analytics and search engines.", "fixture")).toEqual(
      [],
    );
  });
});
