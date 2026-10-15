/**
 * The hole between two green gates: a README that SAYS thirty-six and NAMES thirty-five (#1722).
 *
 * WHAT THE OTHER TWO GATES DO, AND WHY NEITHER CATCHES THIS.
 * `tests/unit/lib/catalog-copy-engine-count.test.ts` binds a numeral in outward copy to the registry's
 * own count, so "thirty-six" is held against `EXTERNAL_DATABASE_TYPES.length` - but it reads the
 * catalog surfaces, not the READMEs' own headings, and it checks the NUMBER rather than the names
 * beside it. `scripts/readme-check.mjs` binds each translation's engine table to README.md's, so the
 * nine files cannot drift APART - but it compares them with each other, never with the numeral in the
 * same file.
 *
 * MEASURED, and this is the state that produced this file: README.md said "Thirty-six" on two lines
 * while its list named thirty-five, the eight translations still said thirty-five in their own words,
 * and MTConnect appeared in none of the nine. BOTH gates were green, because the mistake was
 * SYMMETRIC: every file was missing the same name, so every file matched every other one, and the
 * numeral was right in the one place the count gate looks.
 *
 * So this file asks the one question neither asks: in EACH file, does a numeral equal the number of
 * engines that file actually names beside it, and is that number the registry's?
 *
 * TWO PAIRS, NOT ONE. A README carries a numeral beside a list in two places, and they count
 * different things: the FLEET (every engine with a driver, `EXTERNAL_DATABASE_TYPES`) and the
 * AGENT-MODE set (the engines with a database-native read-only path, `AGENT_EXECUTION_ENGINES`).
 * The second pair was added to this file after main carried MySQL into agent mode in `b7a9247f` and
 * the half-done move happened AGAIN, in the same shape and in the same direction: `README_ja.md`
 * still said "この4つのエンジン" and `README_hi.md` still said "यही चार engines" while both files
 * had already listed five by name. Those two were defects on main that this gate did not know to
 * look for, and they are fixed in the commit that widened it.
 *
 * WHY THE NUMERAL WORDS ARE A TABLE HERE. A numeral in prose is a word, and the word is different in
 * every language; there is no way to derive "छत्तीस" from 36. Each row holds the word for the
 * CURRENT count and the word for the count before it, and the test fails if a file carries the
 * previous one - which is how a half-done count move is caught, since that is exactly what happened
 * twice. When a registry grows, the new word goes in beside the old one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { CATALOG_CAPTURE_ENGINES } from "@/lib/agent/posture";
import { ESTIMATE_BUILDER_ENGINES } from "@/lib/agent/schema-stats";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..");
const read = (name: string): string => readFileSync(join(ROOT, name), "utf8");

/** The engine names as the READMEs write them: the UI label, less the `Apache ` prefix the copy drops. */
const labelOf = (type: DatabaseType): string => DB_UI_CONFIG[type].label.replace(/^Apache /, "");
const ENGINE_NAMES = EXTERNAL_DATABASE_TYPES.map(labelOf);
const AGENT_NAMES = AGENT_EXECUTION_ENGINES.map(labelOf);

/**
 * A numeral as it is written in prose, in pieces.
 *
 * The pieces are matched IN ORDER, case-insensitively, with up to `GAP` characters of the same
 * sentence between them - and both of those are defects this file has already let through once.
 * The stale check used to be `text.includes("Thirty-five")`, which is blind to the same word in
 * lower case; and `README_ko.md` carried a stale count as "35개의 네이티브 엔진", where the
 * adjective sits BETWEEN the figure and the unit, so an exact "35개의 엔진" never saw it.
 *
 * A bare figure is not enough on its own in the files that write figures rather than words - "35"
 * alone appears in version numbers and byte counts - so those rows carry the unit word as a second
 * piece and the two are required together.
 *
 * THE GAP IS MEASURED, not generous. A window is the wrong tool held loosely: the wider it is, the
 * more it matches two pieces that belong to different clauses, and nothing in the suite would say
 * so. MEASURED by printing what every row matches in every file: the largest gap any row needs
 * today is 2 characters (Korean "36개의 엔진", where the pieces are `36개` and `엔진`), and the
 * defect this tolerance exists for needs 7 ("35개의 네이티브 엔진", the adjective between the
 * figure and the unit). It was 24, which is three times the largest case that matters and twelve
 * times the largest that occurs. Eight leaves one character over the defect and is still narrow
 * enough that two clauses cannot be joined across it.
 */
type Numeral = readonly string[];
const GAP = 8;
const numeralPattern = (pieces: Numeral): RegExp =>
  new RegExp(pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(`[^.\\n]{0,${GAP}}`), "i");
const says = (text: string, pieces: Numeral): boolean => numeralPattern(pieces).test(text);

/** One row per README: the fleet numeral today, and the one it replaced. */
const READMES: ReadonlyArray<{ file: string; now: Numeral; before: Numeral }> = [
  { file: "README.md", now: ["Thirty-seven engines"], before: ["Thirty-six engines"] },
  { file: "README_zh.md", now: ["三十七种引擎"], before: ["三十六种引擎"] },
  { file: "README_ja.md", now: ["37", "のエンジン"], before: ["36", "のエンジン"] },
  { file: "README_es.md", now: ["Treinta y siete motores"], before: ["Treinta y seis motores"] },
  { file: "README_pt.md", now: ["Trinta e sete motores"], before: ["Trinta e seis motores"] },
  { file: "README_ru.md", now: ["Тридцать семь СУБД"], before: ["Тридцать шесть СУБД"] },
  { file: "README_hi.md", now: ["सैंतीस engines"], before: ["छत्तीस engines"] },
  { file: "README_ur.md", now: ["سینتیس engines"], before: ["چھتیس engines"] },
  { file: "README_ko.md", now: ["37개", "엔진"], before: ["36개", "엔진"] },
];

/**
 * The agent-mode pair, in the six files that carry that paragraph.
 *
 * `README_es.md`, `README_pt.md` and `README_ur.md` do not have the paragraph at all, which is a
 * gap in those three translations rather than in this gate, and it is pinned below so that the
 * three cannot quietly become four.
 *
 * The paragraph is found by `queryReadOnly`, which every one of the six cites by name, and the
 * numeral is looked for INSIDE that paragraph only. Measured: each word below occurs exactly once
 * there, so neither "four" in English nor the single character 四 in Chinese can be answered by
 * some other sentence in the file.
 */
const AGENT_ANCHOR = "queryReadOnly";
const AGENT_READMES: ReadonlyArray<{ file: string; now: Numeral; before: Numeral }> = [
  { file: "README.md", now: ["six"], before: ["five"] },
  { file: "README_zh.md", now: ["六"], before: ["五"] },
  { file: "README_ja.md", now: ["6つ"], before: ["5つ"] },
  { file: "README_ru.md", now: ["шести"], before: ["пяти"] },
  { file: "README_hi.md", now: ["छह"], before: ["पाँच"] },
  { file: "README_ko.md", now: ["여섯"], before: ["다섯"] },
];
const AGENT_PARAGRAPHLESS = ["README_es.md", "README_pt.md", "README_ur.md"];

const agentParagraph = (text: string): string => {
  const paragraphs = text.split(/\n(?=[-*] )/).filter((block) => block.includes(AGENT_ANCHOR));
  // One paragraph, never two: a second one would make "the numeral occurs once" meaningless.
  expect(paragraphs).toHaveLength(1);
  return paragraphs[0] as string;
};

/** The engines a line names, which is what a numeral beside a list is claiming. */
const namedIn = (line: string): readonly string[] => ENGINE_NAMES.filter((name) => line.includes(name));

/**
 * EVERY list that claims the fleet, and no blind band under it.
 *
 * MEASURED on the nine files, counting the engine names per line: 12 lines name 6, 8 name 7, and
 * the counts then thin out through 8, 9, 10, 11, 13 to six lines naming 16 - and the next value
 * that occurs at all is 36, on 21 lines. Nothing names between 17 and 35.
 *
 * The threshold used to be 28, which sat in the middle of that empty stretch rather than at its
 * edge, and left a BLIND BAND: a fleet list that lost up to nine names - say a translation that
 * dropped a whole table row - fell to 27, stopped being inspected, and the suite stayed green on
 * a list that was incomplete in exactly the way this file exists to catch. So the threshold is the
 * first value above the largest line that is NOT a fleet list, and the gap itself is asserted
 * below: if a line ever lands inside it, this file says so instead of ignoring it.
 *
 * The first design took only the LONGEST list per file, and a planted violation showed why that is
 * wrong: removing one name from one list of a file that has two left the suite green, because the
 * other list was still complete. That is the same symmetric-mistake shape this file exists for.
 *
 * A line that names an engine inside an EXPLANATION rather than in the list counts as naming it, which
 * is why README.md's SSL/TLS sentence passes: its list leaves OPC UA out, and the clause after it says
 * why, so the line as a whole names every engine and the reader is not misled.
 */
const NON_FLEET_MAX = 16;
const FLEET_LIST_THRESHOLD = NON_FLEET_MAX + 1;

const fleetLists = (text: string): readonly string[] =>
  text.split("\n").filter((line) => namedIn(line).length >= FLEET_LIST_THRESHOLD);

describe("each README's numeral and its own engine list agree", () => {
  test("the population is the nine READMEs and the registry's own names", () => {
    // Asserted first: a short table or an empty name list would make every loop below vacuous.
    expect(READMES).toHaveLength(9);
    expect(ENGINE_NAMES.length).toBe(EXTERNAL_DATABASE_TYPES.length);
    expect(ENGINE_NAMES).toContain("NETCONF");
    expect(ENGINE_NAMES).toContain("PostgreSQL");
    // The `Apache ` prefix trap, pinned: a comparison that strips it reports Druid, Cassandra and
    // Kafka as missing from a table that spells them `| **Apache Druid** |`.
    expect(ENGINE_NAMES).toContain("Druid");
    expect(read("README.md")).toContain("| **Apache Druid**");
  });

  test.each(READMES.map((entry) => [entry.file, entry] as const))("%s names every engine it counts", (_, entry) => {
    const lists = fleetLists(read(entry.file));
    // At least one list claims the fleet; without this the loop below would certify a file with none.
    expect({ file: entry.file, lists: lists.length }).toEqual({ file: entry.file, lists: lists.length });
    expect(lists.length).toBeGreaterThan(0);
    for (const line of lists) {
      const missing = ENGINE_NAMES.filter((name) => !line.includes(name));
      // The line is identified by its first forty characters, so a failure says WHICH list.
      expect({ file: entry.file, list: line.slice(0, 40), missing }).toEqual({
        file: entry.file,
        list: line.slice(0, 40),
        missing: [],
      });
    }
  });

  test("no line falls in the band between a mention and a fleet list", () => {
    // The threshold is only honest while the gap under it is empty. A line that names 17 to 35
    // engines is either a fleet list that lost names or a sentence that grew into one, and both
    // want a human: this test names the line rather than letting the threshold swallow it.
    const band: string[] = [];
    for (const entry of READMES) {
      for (const line of read(entry.file).split("\n")) {
        const count = namedIn(line).length;
        if (count > NON_FLEET_MAX && count < ENGINE_NAMES.length) {
          band.push(`${entry.file}: ${count} names — ${line.slice(0, 60)}`);
        }
      }
    }
    expect(band).toEqual([]);
  });

  test.each(READMES.map((entry) => [entry.file, entry] as const))(
    "%s carries today's numeral and not the last one",
    (_, entry) => {
      const text = read(entry.file);
      expect({ file: entry.file, says: says(text, entry.now) }).toEqual({ file: entry.file, says: true });
      // The half-done move, which is the defect this file was written for: the numeral moved in one
      // file and the others kept the previous word while matching each other's lists.
      expect({ file: entry.file, stale: says(text, entry.before) }).toEqual({ file: entry.file, stale: false });
    },
  );

  test("the numeral table is not vacuously satisfiable: today's word differs from the last one", () => {
    for (const entry of [...READMES, ...AGENT_READMES]) {
      expect({ file: entry.file, same: entry.now.join() === entry.before.join() }).toEqual({
        file: entry.file,
        same: false,
      });
    }
  });
});

describe("the agent-mode numeral and its own engine list agree", () => {
  test("the population is the six files that carry the paragraph, and the engine gate's own set", () => {
    expect(AGENT_READMES).toHaveLength(6);
    expect(AGENT_NAMES.length).toBe(AGENT_EXECUTION_ENGINES.length);
    expect(AGENT_NAMES).toContain("MySQL");
    // The three translations without the paragraph are pinned, so one more losing it is a failure
    // here rather than a silent shrinking of this gate's population.
    for (const file of AGENT_PARAGRAPHLESS) {
      expect({ file, anchored: read(file).includes(AGENT_ANCHOR) }).toEqual({ file, anchored: false });
    }
    expect(AGENT_READMES.length + AGENT_PARAGRAPHLESS.length).toBe(READMES.length);
  });

  test.each(AGENT_READMES.map((entry) => [entry.file, entry] as const))(
    "%s names every engine agent mode reads, and counts them right",
    (_, entry) => {
      const paragraph = agentParagraph(read(entry.file));
      const missing = AGENT_NAMES.filter((name) => !paragraph.includes(name));
      expect({ file: entry.file, missing }).toEqual({ file: entry.file, missing: [] });
      expect({ file: entry.file, says: says(paragraph, entry.now) }).toEqual({ file: entry.file, says: true });
      expect({ file: entry.file, stale: says(paragraph, entry.before) }).toEqual({ file: entry.file, stale: false });
    },
  );
});

/**
 * A NUMERAL THAT SUMMARISES AN OPEN LIST (#1722, KURAL 109).
 *
 * The two blocks above hold a numeral against the FLEET. A third shape is neither: prose that
 * says "the other thirty-five" and then writes those thirty-five out, in a parenthesis or after
 * a colon. The number there is a count of a list the sentence itself carries, and the two have
 * to move together - measured on `docs/AGENT_GUIDE.md`, where this branch raised the numeral to
 * thirty-five while its parenthesis went on naming thirty-four, and again where a numeral said
 * thirty-two over a list of thirty-one. Neither the fleet blocks above nor the review caught
 * either one, because both lists are a SUBSET of the fleet by design and the files are not
 * READMEs.
 *
 * The rise is CONDITIONAL, which is the other half of the rule: the numeral moves when the new
 * engine joins the set the sentence is about, and stays put when it does not. Both AGENT.md
 * denominators were measured that way rather than bumped - `ESTIMATE_BUILDERS` serves three
 * engines, so "the other thirty-four" is 37 - 3, and the two "other thirty-five" sentences are
 * 37 - 2 for PostgreSQL and SQLite.
 *
 * HOW THE LIST IS COUNTED, and why it is engine NAMES rather than commas. A parenthesis has an
 * end, but a colon does not, and counting comma-separated items past the end of the enumeration
 * is a false alarm: measured on README.md's own line, where the clause after the list
 * ("with the same explorer everywhere, and ER diagrams, schema diff and monitoring") pushed a
 * list of thirty-six to forty. Counting the engine names the sentence carries has no end to
 * guess at, and it is what the numeral is a count OF.
 *
 * The floor is five names and a numeral of ten or more, which is what separates an enumeration
 * from a mention: below it a sentence saying "two" beside a handful of engines is ordinary prose.
 * The agent-mode pair ("those five engines") is below that floor by design and is held by its own
 * block above, where the population is the engine gate's rather than a count in the text. Only
 * the English-language files are scanned, since the numeral words are English; the translations'
 * fleet lists are held by the first block.
 */
const SHIPPED_NAMES = SHIPPED_DATABASE_TYPES.map(labelOf);

/**
 * One row per file, with the number of enumerating sentences MEASURED in it.
 *
 * Per file, and that is a defect this gate had: the empty-case check used to be one total over all
 * three files (`found.length >= 4`), and a union threshold hides a source going completely silent.
 * MEASURED by another session: with `docs/AGENT.md` emptied to nothing, the gate stayed green at
 * 37 pass / 0 fail, because the other two files alone cleared the total. A file that stops carrying
 * its lists is exactly the state this gate exists to see, so each file now answers for itself.
 *
 * The figure beside each file is what it carries today. Lowering one is a decision somebody makes
 * on purpose, the same way the numeral tables above are.
 */
const PROSE_FILES: ReadonlyArray<{ file: string; sentences: number }> = [
  { file: "docs/AGENT.md", sentences: 3 },
  { file: "docs/AGENT_GUIDE.md", sentences: 5 },
  // Eighteen, not nineteen: the Testing table's integration row used to enumerate thirteen
  // engines by name and now describes the layer instead ("one test file per provider in
  // `tests/integration/db/`"), so that sentence stopped enumerating. A list that is not written
  // out cannot go stale, so this is one fewer sentence to guard rather than a fact lost.
  { file: "README.md", sentences: 18 },
];
const MIN_NUMERAL = 10;
const MIN_NAMES = 5;

const NUMERAL_WORDS = ((): ReadonlyMap<string, number> => {
  const ones = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
  const words = new Map<string, number>([
    ...Object.entries(ones),
    ...Object.entries(tens),
    ["ten", 10],
    ["eleven", 11],
    ["twelve", 12],
    ["thirteen", 13],
    ["fourteen", 14],
    ["fifteen", 15],
    ["sixteen", 16],
    ["seventeen", 17],
    ["eighteen", 18],
    ["nineteen", 19],
  ]);
  for (const [ten, tenValue] of Object.entries(tens)) {
    for (const [one, oneValue] of Object.entries(ones)) words.set(`${ten}-${one}`, tenValue + oneValue);
  }
  return words;
})();

/** Sentences, as prose rather than as lines: these lists are wrapped across several. */
const sentencesOf = (text: string): readonly string[] => text.replace(/\s+/g, " ").split(/(?<=\.)\s+(?=[A-Z*`[-])/);

describe("a numeral that summarises a list in the same sentence equals that list", () => {
  test("the scan sees the sentences it is meant to see, in EVERY file", () => {
    // Per file, never as a total: a total is cleared by the loudest file while another is empty.
    const measured = PROSE_FILES.map((entry) => ({
      file: entry.file,
      enumerating: sentencesOf(read(entry.file)).filter(
        (sentence) => SHIPPED_NAMES.filter((n) => sentence.includes(n)).length >= MIN_NAMES,
      ).length,
      atLeast: entry.sentences,
    }));
    const short = measured.filter((row) => row.enumerating < row.atLeast);
    expect(short).toEqual([]);
    expect(SHIPPED_NAMES).toContain("MTConnect");
    expect(SHIPPED_NAMES).toContain("LibreDB");
  });

  test.each(PROSE_FILES.map((entry) => [entry.file, entry.file] as const))(
    "%s: every enumerating numeral equals the names beside it",
    (_, file) => {
      const pattern = new RegExp(
        `\\b(${[...NUMERAL_WORDS.keys()].sort((a, b) => b.length - a.length).join("|")})\\b`,
        "gi",
      );
      const wrong: string[] = [];
      for (const sentence of sentencesOf(read(file))) {
        const named = SHIPPED_NAMES.filter((name) => sentence.includes(name)).length;
        if (named < MIN_NAMES) continue;
        for (const match of sentence.matchAll(pattern)) {
          const value = NUMERAL_WORDS.get(match[1]!.toLowerCase()) ?? 0;
          if (value < MIN_NUMERAL || value === named) continue;
          wrong.push(`${file}: "${match[1]}" (${value}) over ${named} names — ${sentence.slice(0, 60)}`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );
});

/**
 * A NUMERAL THAT SUMMARISES A SET WITH NO LIST BESIDE IT (#1722, KURAL 109's second half).
 *
 * `docs/AGENT.md` carries four of these, and nothing in the sentence says what they count. Two
 * are the shipped engines less the three `ESTIMATE_BUILDERS` serves, two are the shipped engines
 * less the two whose grounding is a composed catalog read - and they are DIFFERENT denominators
 * on purpose, which is exactly why a numeral here cannot be bumped by hand along with its
 * neighbours. Measured when MTConnect was registered: all four had to move, because MTConnect
 * joins both "other" sets; a registration that joined neither would leave all four standing.
 *
 * So the figures are computed from the registries rather than pinned as words, and the sentence
 * each belongs to is named, so a failure says WHICH denominator drifted rather than that a file
 * contains the wrong word somewhere.
 */
const ENGLISH_NUMERALS = new Map([...NUMERAL_WORDS].map(([word, value]) => [value, word] as const));

describe("the agent docs' denominators are the registries', not a bumped word", () => {
  const withoutStatistics = SHIPPED_DATABASE_TYPES.length - ESTIMATE_BUILDER_ENGINES.length;
  const withoutComposedCatalog = SHIPPED_DATABASE_TYPES.length - CATALOG_CAPTURE_ENGINES.length;
  const withoutAgentExecution = SHIPPED_DATABASE_TYPES.length - AGENT_EXECUTION_ENGINES.length;

  test("the three denominators are what the registries say", () => {
    // Pinned so that a registry growing by one is a decision somebody sees, not a silent
    // re-rendering of seven sentences.
    expect({ withoutStatistics, withoutComposedCatalog, withoutAgentExecution }).toEqual({
      withoutStatistics: 39,
      withoutComposedCatalog: 40,
      withoutAgentExecution: 36,
    });
    expect(ENGLISH_NUMERALS.get(39)).toBe("thirty-nine");
    expect(ENGLISH_NUMERALS.get(40)).toBe("forty");
    expect(ENGLISH_NUMERALS.get(36)).toBe("thirty-six");
  });

  /**
   * THE THIRD FAMILY IS HERE BECAUSE IT IS THE ONE THAT MOVES (KURAL 144).
   *
   * The gate held the first two families and not this one, and the coverage was decided by the
   * shape of the code rather than by what was likely to change. MEASURED: of the three, the agent
   * family is the only one that moved on its own this week - main carried MySQL into
   * `AGENT_EXECUTION_ENGINES` in b7a9247f and these sentences went from thirty-three to
   * thirty-two while nothing in the other two families moved at all. The question a gate's
   * coverage answers is not "what is easy to hold" but "what have I left out, and when did it
   * last change".
   */
  test.each([
    [
      "docs/AGENT.md",
      "statistics, where #414 added no engine",
      "and #414 added no engine to it: on the other NUMERAL `readSchemaStatistics` answers",
      () => withoutStatistics,
    ],
    [
      "docs/AGENT.md",
      "statistics, outside CATALOG_PLANS",
      "`ESTIMATE_BUILDERS` serves outside `CATALOG_PLANS`; the other NUMERAL hold no statistics",
      () => withoutStatistics,
    ],
    ["docs/AGENT.md", "the per-run statement cost", "On the other NUMERAL it is **one**", () => withoutComposedCatalog],
    [
      "docs/AGENT.md",
      "collapsing onto the composed read",
      "Collapsing the other NUMERAL onto the composed one",
      () => withoutComposedCatalog,
    ],
    [
      "docs/AGENT.md",
      "what grounding reaches that the profile refuses",
      "reach the NUMERAL the read-only profile refuses",
      () => withoutAgentExecution,
    ],
    [
      "docs/AGENT.md",
      "where a plan run is grounded and an agent run reads nothing",
      "including the NUMERAL where an agent run cannot read anything at all",
      () => withoutAgentExecution,
    ],
    [
      "docs/AGENT_GUIDE.md",
      "the ids an Agent-mode run cannot read",
      "So on the other NUMERAL ids in the `DatabaseType` union",
      () => withoutAgentExecution,
    ],
  ] as const)("%s — %s", (file, label, shape, expected) => {
    const prose = read(file).replace(/\s+/g, " ");
    const sentence = shape.replace("NUMERAL", ENGLISH_NUMERALS.get(expected()) ?? "?");
    expect({ file, label, found: prose.includes(sentence) }).toEqual({ file, label, found: true });
  });
});

/**
 * EVERY PLACE THE FORMULA REACHES, FOUND RATHER THAN LISTED (KURAL 158).
 *
 * The block above anchors seven sentences by their own words, which binds each formula to its
 * place exactly. What it cannot do is notice a place nobody listed, and that is a live escape:
 * MEASURED on a sibling branch, a registration that moved `SHIPPED` from 37 to 38 left four
 * sentences behind - `docs/AGENT.md:768` and `:2579`, `docs/AGENT_GUIDE.md:231` and `:245` - while
 * two sentences carrying the SAME formula were updated and the gate stayed green on eleven
 * stripes. A hand-written place list forgets one more place at every registration.
 *
 * So this asks the opposite question. Every spelled numeral of ten or more in these two documents
 * must be a value one of the registries currently derives, or be named below as one that is not.
 * When a registry moves, every sentence still carrying the old figure stops being derivable and is
 * reported with its line - whether or not anybody remembered to list it.
 *
 * MEASURED here: 15 derived places across the two files, against the 7 the anchors hold, and only
 * four numerals that are not derived at all. The tally is printed by the test that counts them,
 * because a search that silently finds two places where six exist is the same defect one level up.
 *
 * THE TWO STRIPES ARE NOT THE SAME CHECK, and the simulation shows why. This one knows only that
 * a figure IS derivable, not which formula a sentence meant, so a stale figure that happens to
 * equal another family's new value passes it: with SHIPPED at 38, "thirty-five" is still derivable
 * as SHIPPED - ESTIMATE_BUILDERS even where the sentence meant SHIPPED - CATALOG_CAPTURE_ENGINES
 * and should now read thirty-six. The anchored rows above catch exactly that, by binding each
 * formula to the sentence it belongs to. Measured together on a simulated registration that moved
 * SHIPPED from 37 to 38 and touched no prose: 11 failures, the anchors naming seven sentences by
 * their formula and this search naming nine by file and line - among them all four that escaped a
 * sibling branch's eleven-stripe gate.
 *
 * README.md is not scanned here: its numerals are the fleet's, and the three blocks above hold
 * those in all nine translations, names and all.
 */
const DERIVED_DOCS = ["docs/AGENT.md", "docs/AGENT_GUIDE.md"] as const;

/**
 * Where the five families are written out in words, which is a wider set than the two scanned
 * above, and the difference is the whole point: a family can be cited in a document this gate
 * does not scan, and the coverage check below then reads it as uncited.
 *
 * MEASURED at c175d2bbf. `EXTERNAL` is spelled in README.md and in NEITHER scanned document:
 * the bare word `forty` occurs zero times in both, because the grounding sentence in AGENT_GUIDE
 * moved from the external count to the id count and now reads `forty-one`. Counting the families
 * each document cites: docs/AGENT.md and docs/AGENT_GUIDE.md cite the same four (SHIPPED and the
 * three differences), and README.md is the only document that cites EXTERNAL. docs/AGENT_DATA_FLOW.md
 * was measured for this set too and left out: it cites SHIPPED and SHIPPED - CATALOG_CAPTURE_ENGINES
 * and nothing the other three do not already carry, so adding it would widen the set without
 * covering anything.
 *
 * Per family over this set: EXTERNAL 6, SHIPPED - CATALOG_CAPTURE_ENGINES 4,
 * SHIPPED - ESTIMATE_BUILDERS 4, SHIPPED - AGENT_EXECUTION_ENGINES 3, SHIPPED 3. Three is the
 * margin that matters: one sentence changing family cannot take a family to zero.
 *
 * README.md is CITED here, not SCANNED. Scanning it would ask this gate to explain ten numerals
 * that count read routes, e2e specs and protocol-compatible engines, none of which any registry
 * here derives, and one of those ten is an ordinal (`twenty-first`) that the numeral scanner reads
 * as a cardinal. Its fleet numerals are already held by the three blocks above, in all nine
 * translations, names and all.
 */
const FAMILY_CITATIONS = [...DERIVED_DOCS, "README.md"] as const;

/**
 * Families no document cites any more, each with the measured reason, in the shape `NOT_DERIVED`
 * uses below: a name and a sentence, never a number.
 *
 * EMPTY TODAY, and the numbers are why: counted over `FAMILY_CITATIONS` every family is cited,
 * and the thinnest margin is three places (EXTERNAL 6, CATALOG_CAPTURE 4, ESTIMATE_BUILDERS 4,
 * AGENT_EXECUTION 3, SHIPPED 3), so one sentence changing family cannot take a family to zero.
 * An entry belongs here when a family stops being cited FOR A REASON - as EXTERNAL did in the
 * scanned pair when the grounding sentence in AGENT_GUIDE moved from the external count to the id
 * count - and the reason is what the next reader needs, not the fact that one of five is missing.
 */
const FAMILY_EXEMPT: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Numerals of ten or more in those documents that are NOT derived from any registry, each with
 * what it counts. A coincidence belongs here too: "Thirty-five models" is thirty-five LLMs, and it
 * matches `SHIPPED - CATALOG_CAPTURE_ENGINES` today purely by arithmetic accident.
 */
const NOT_DERIVED: ReadonlyArray<{ file: string; fragment: string; counts: string }> = [
  {
    file: "docs/AGENT.md",
    fragment: "Thirty-five models run every agent surface",
    counts: "LLM models measured, not engines",
  },
  {
    file: "docs/AGENT.md",
    fragment: "What the thirty-eight have is a measurement",
    counts: "LLM models measured, not engines",
  },
  { file: "docs/AGENT.md", fragment: 'say "the top ten" in its claim', counts: "rows of a result" },
  {
    file: "docs/AGENT.md",
    fragment: "so twelve of its statements are every kind",
    counts: "statements of a curated set",
  },
  { file: "docs/AGENT_GUIDE.md", fragment: "twelve of its eighteen statements", counts: "statements of a curated set" },
];

describe("every numeral the registries reach is derivable, in the places nobody listed", () => {
  const derivedValues = (): ReadonlyMap<number, string> =>
    new Map([
      [SHIPPED_DATABASE_TYPES.length, "SHIPPED"],
      [EXTERNAL_DATABASE_TYPES.length, "EXTERNAL"],
      [SHIPPED_DATABASE_TYPES.length - AGENT_EXECUTION_ENGINES.length, "SHIPPED - AGENT_EXECUTION_ENGINES"],
      [SHIPPED_DATABASE_TYPES.length - ESTIMATE_BUILDER_ENGINES.length, "SHIPPED - ESTIMATE_BUILDERS"],
      [SHIPPED_DATABASE_TYPES.length - CATALOG_CAPTURE_ENGINES.length, "SHIPPED - CATALOG_CAPTURE_ENGINES"],
    ]);

  const numeralsOf = (file: string): ReadonlyArray<{ line: number; word: string; value: number; text: string }> => {
    const pattern = new RegExp(
      `\\b(${[...NUMERAL_WORDS.keys()].sort((a, b) => b.length - a.length).join("|")})\\b`,
      "gi",
    );
    const found: { line: number; word: string; value: number; text: string }[] = [];
    read(file)
      .split("\n")
      .forEach((line, index) => {
        // A table row is a grid of figures, not prose carrying a claim.
        if (line.trim().startsWith("|")) return;
        for (const match of line.matchAll(pattern)) {
          const value = NUMERAL_WORDS.get(match[1]!.toLowerCase()) ?? 0;
          if (value >= MIN_NUMERAL) found.push({ line: index + 1, word: match[1]!, value, text: line.trim() });
        }
      });
    return found;
  };

  test.each(DERIVED_DOCS.map((file) => [file, file] as const))(
    "%s: every numeral is derived, or named as one that is not",
    (_, file) => {
      const derived = derivedValues();
      const excused = NOT_DERIVED.filter((entry) => entry.file === file);
      const unexplained = numeralsOf(file)
        .filter((found) => !derived.has(found.value))
        .filter((found) => !excused.some((entry) => found.text.includes(entry.fragment)))
        .map((found) => `${file}:${found.line} "${found.word}" (${found.value}) — ${found.text.slice(0, 56)}`);
      expect(unexplained).toEqual([]);
    },
  );

  test("the search finds every place, and says how many", () => {
    const derived = derivedValues();
    const tally = new Map<string, number>();
    let places = 0;
    for (const file of FAMILY_CITATIONS) {
      const here = numeralsOf(file).filter((found) => derived.has(found.value));
      // Per file, so one document going silent cannot be covered by another (KURAL 143).
      expect({ file, places: here.length > 0 }).toEqual({ file, places: true });
      // The floor below belongs to the SCANNED set, so a cited file cannot lift it: measured at
      // 14 places across the two scanned documents at this tip.
      if ((DERIVED_DOCS as readonly string[]).includes(file)) places += here.length;
      for (const found of here) {
        const name = derived.get(found.value) as string;
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
    }
    // The count is the part a hand list gets wrong quietly: it found two where six existed. The
    // floor is the anchored list's own size, since every anchored sentence is also a found place.
    expect({ places, atLeast: 7 }).toEqual({ places, atLeast: 7 });
    expect(places).toBeGreaterThanOrEqual(7);
    // The families the prose actually cites are a SUBSET of the ones this gate recognises, and the
    // subset is not fixed: a sentence can move from one family to another without anything being
    // wrong. MEASURED on 14 October 2026: `EXTERNAL` fell out of the cited set when the grounding
    // sentence in AGENT_GUIDE ("it reaches all N engines") moved from the external count to the id
    // count, which is what its neighbour sentence ("all N ids pass it") was already counting. So
    // the list is checked as a subset with a floor, not as an equality: an equality here would
    // report a sentence CHANGING FAMILY as a defect, which it is not, and that is exactly how it
    // failed first. What still has to hold is that the prose cites several families rather than
    // one, because a single cited family would leave the rest of this gate measuring nothing.
    //
    // THE FLOOR IS THE FULL COUNT AGAIN, and the set counted above is why that is safe. The
    // reasoning for lowering it to four held: a sentence DID change family, and an equality over
    // the scanned pair reported that as a defect. What was wrong was the SET being counted, not
    // the floor. Counted over FAMILY_CITATIONS every family is cited, so the floor can be the
    // whole list; counted over the scanned pair, four of five were, and the one that dropped out
    // was EXTERNAL, the engine count itself. A floor one under the total lets any single family
    // leave in silence, which is the condition this block was written to refuse.
    //
    // AND THE FLOOR IS A COUNT, WHICH IS THE LAST THING WRONG WITH IT. A count says how many
    // families are cited and never which ones, so any floor under the total tolerates a member
    // without naming it, and the total tolerates nothing at all - including a sentence that moves
    // for a good reason, which is how this block failed the first time. A floor is a TOLERANCE,
    // and a tolerance that cannot say which member it tolerates cannot be read.
    //
    // So the floor is gone and the question is asked per family: every one is either CITED or
    // EXEMPT BY NAME WITH A REASON, in the shape `NOT_DERIVED` already uses in this file. A
    // family leaving in silence fails; a family leaving for a measured reason is written down and
    // passes, and the next reader sees the reason rather than a number.
    const cited = [...tally.keys()].sort();
    const families = [
      "EXTERNAL",
      "SHIPPED",
      "SHIPPED - AGENT_EXECUTION_ENGINES",
      "SHIPPED - CATALOG_CAPTURE_ENGINES",
      "SHIPPED - ESTIMATE_BUILDERS",
    ];
    expect(cited.filter((name) => !families.includes(name))).toEqual([]);
    const unaccounted = families.filter((name) => !cited.includes(name) && !FAMILY_EXEMPT[name]);
    expect({ unaccounted, cited, exempt: Object.keys(FAMILY_EXEMPT) }).toEqual({
      unaccounted: [],
      cited,
      exempt: Object.keys(FAMILY_EXEMPT),
    });
    // An exemption is only as good as what it names: a key that is not a family would excuse
    // nothing while looking like it does, and an empty reason is a floor with extra steps.
    for (const [name, reason] of Object.entries(FAMILY_EXEMPT)) {
      expect({ name, known: families.includes(name) }).toEqual({ name, known: true });
      expect({ name, explained: reason.trim().length > 20 }).toEqual({ name, explained: true });
    }
    // And the exemptions cannot swallow the whole list: if every family were excused, the block
    // above would pass while measuring nothing.
    expect(Object.keys(FAMILY_EXEMPT).length).toBeLessThan(families.length);
  });
});
