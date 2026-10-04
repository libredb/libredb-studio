/**
 * The accuracy gate for the engine COUNT in outward-facing catalog copy (#518).
 *
 * Fifteen files outside `src/` name the engine set by hand, and until this test nothing
 * counted them: `scripts/readme-check.mjs` locates the engine table in the three
 * READMEs and `chart:check` pins a version across files, but a storefront listing was
 * only ever corrected by somebody noticing. Measured on the DuckDB registration branch,
 * every one of the original nine was a full engine behind two weeks after libSQL shipped
 * (#511), and DuckDB was the second engine in a row to walk into it.
 *
 * The rule is not "every file names every engine" - several of them deliberately
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
 * The fifteen files that publish the engine set outward. Each is copy somebody else's
 * catalog renders, so nobody in this repo reads it again once it is submitted.
 *
 * `deploy/rancher/app-readme.md` is the one that is not itself the submitted artifact: the
 * file Rancher renders lives in `rancher/partner-charts` under
 * `packages/libredb/libredb-studio/overlay/`, out of reach of any test here, and it drifted
 * six engines behind before anybody looked. This copy is what a submission is cut from, so
 * the drift fails here first.
 *
 * `from`/`to` cut away editorial matter, and only `CATALOG_LISTING.md` has any: its
 * accuracy-gate blockquote and its outstanding-corrections table exist to NAME stale
 * numerals (including a quote of the count the LIVE listing still publishes), so a
 * count check over the whole file would fail on the note that warns about the count.
 * The same slice is used by `tests/unit/marketplace-copy.test.ts`. `packaging/aur/PKGBUILD` is cut to
 * its `pkgdesc` line, because the rest of the file is build script; its `.SRCINFO` is generated
 * from it by `makepkg --printsrcinfo` and follows it.
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
  { path: "deploy/aws/listing/listing-fields.md" },
  { path: "deploy/aws/listing/description.md" },
  { path: "deploy/rancher/CATALOG_LISTING.md", from: "## Short description", to: "## Outstanding corrections" },
  { path: "deploy/rancher/app-readme.md" },
  { path: "deploy/rancher/pcsc-listing.html" },
  { path: "packaging/aur/PKGBUILD", from: "pkgdesc=", to: "\narch=" },
  { path: "deploy/digitalocean/assets/description-long.md" },
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
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
  "twenty-five": 25,
  "twenty-six": 26,
  "twenty-seven": 27,
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

/**
 * The relative form, "PostgreSQL, MySQL, MongoDB, Redis and N more engines": the claim is
 * the engines named in front of it plus N. The form above never reads it, because "more"
 * stands between the numeral and the noun, and the DigitalOcean listing kept "fifteen
 * more" for a release after the twentieth engine landed.
 */
const RELATIVE_ENGINE_COUNT_RE = new RegExp(
  `\\b(\\d{1,3}|${Object.keys(NUMERAL_WORDS).join("|")})\\s+more\\s+(?:database\\s+)?engines\\b`,
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

/** The sentence (or bullet, or block) up to `offset`: what a relative numeral adds to. */
function leadSegment(text: string, offset: number): string {
  const before = text.slice(0, offset);
  let start = 0;
  for (const end of before.matchAll(new RegExp(SEGMENT_END_RE.source, "g"))) {
    start = (end.index ?? 0) + end[0].length;
  }
  return before.slice(start);
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

  for (const match of text.matchAll(RELATIVE_ENGINE_COUNT_RE)) {
    const written = match[1].toLowerCase();
    const more = NUMERAL_WORDS[written] ?? Number(written);
    const lead = leadSegment(text, match.index ?? 0);
    const named = ENGINE_NAMES.filter(({ name }) => lead.includes(name)).length;
    if (named + more !== expected) {
      problems.push(`${label}: "${named} named and ${match[0]}" publishes ${named + more}, and there are ${expected}`);
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

    // Sixteen numerals and eight counted lists on this revision - the two AWS
    // listing files abridge, so they add numerals without adding counted lists.
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
    // The word for the current count is looked up, not written here, so this fixture does
    // not go stale with the copy it guards.
    const word = Object.keys(NUMERAL_WORDS).find((key) => NUMERAL_WORDS[key] === expected);
    expect(word).toBeDefined();
    const capitalized = `${word?.charAt(0).toUpperCase()}${word?.slice(1)}`;

    expect(engineCountProblems("Query fourteen engines from your browser.", "fixture")).toHaveLength(1);
    expect(engineCountProblems(`${capitalized} database engines in one IDE: ${fullList}`, "fixture")).toEqual([]);
  });

  test("a hyphenated numeral is read whole, not as its first word", () => {
    // "twenty-one engines" must publish 21. Read as "twenty" it would pass on the day the
    // count is twenty and the copy is one ahead.
    expect(engineCountProblems("Query twenty-one engines from your browser.", "fixture")).toEqual(
      expected === 21 ? [] : [`fixture: "twenty-one engines" publishes 21, and there are ${expected}`],
    );
    expect(engineCountProblems("Query Twenty-Five database engines.", "fixture")).toEqual(
      expected === 25 ? [] : [`fixture: "Twenty-Five database engines" publishes 25, and there are ${expected}`],
    );
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

  test("a relative numeral is counted with the engines named before it", () => {
    // "PostgreSQL, MySQL, MongoDB, Redis and N more engines" claims 4 + N. The DigitalOcean
    // listing published "and fifteen more" for a release after the twentieth engine
    // landed, because the walk read only the "N engines" form.
    const lead = "connect to PostgreSQL, MySQL, MongoDB, Redis and";
    const rightWord = Object.keys(NUMERAL_WORDS).find((key) => NUMERAL_WORDS[key] === expected - 4);
    expect(rightWord).toBeDefined();

    expect(engineCountProblems(`${lead} ${rightWord} more engines, write queries.`, "fixture")).toEqual([]);
    expect(engineCountProblems(`${lead} ${expected - 5} more engines, write queries.`, "fixture")).toEqual([
      `fixture: "4 named and ${expected - 5} more engines" publishes ${expected - 1}, and there are ${expected}`,
    ]);
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
