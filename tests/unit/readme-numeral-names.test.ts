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
 * So this file asks the one question neither asks: in EACH file, does the numeral equal the number of
 * engines that file actually names, and is that number the registry's?
 *
 * WHY THE NUMERAL WORDS ARE A TABLE HERE. A numeral in prose is a word, and the word is different in
 * every language; there is no way to derive "छत्तीस" from 36. The table below holds one word per
 * language for the CURRENT count and one for the count before it, and the test fails if a file
 * carries the previous word anywhere - which is how a half-done count move is caught, since that is
 * exactly what happened here. When the registry grows, the new word goes in beside the old one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..");
const read = (name: string): string => readFileSync(join(ROOT, name), "utf8");

/** The engine names as the READMEs write them: the UI label, less the `Apache ` prefix the copy drops. */
const ENGINE_NAMES = EXTERNAL_DATABASE_TYPES.map((type) => DB_UI_CONFIG[type].label.replace(/^Apache /, ""));

/**
 * One row per README: the numeral word for today's count, and the one for the count before it.
 *
 * `README_ja.md` writes the figure rather than a word, which is that file's own style, so its pair is
 * digits. Every other file writes it out.
 */
const READMES: ReadonlyArray<{ file: string; now: string; before: string }> = [
  { file: "README.md", now: "Thirty-nine", before: "Thirty-seven" },
  { file: "README_zh.md", now: "三十九", before: "三十七" },
  { file: "README_ja.md", now: "39のエンジン", before: "37のエンジン" },
  { file: "README_es.md", now: "Treinta y nueve", before: "Treinta y siete" },
  { file: "README_pt.md", now: "Trinta e nove", before: "Trinta e sete" },
  { file: "README_ru.md", now: "Тридцать девять", before: "Тридцать семь" },
  { file: "README_hi.md", now: "अड़तीस", before: "सैंतीस" },
  { file: "README_ur.md", now: "اڑتیس", before: "سینتیس" },
  { file: "README_ko.md", now: "39개의 엔진", before: "37개의 엔진" },
];

/** The engines a line names, which is what a numeral beside a list is claiming. */
const namedIn = (line: string): readonly string[] => ENGINE_NAMES.filter((name) => line.includes(name));

/**
 * EVERY list that claims the fleet, not only the longest one.
 *
 * MEASURED, and the threshold is the measurement: across the nine files, a line names either at most
 * a handful of engines or at least 28 of the 36, with nothing in between. So 28 is the line between
 * "a sentence that mentions some engines" and "a list that claims the fleet", and every list above it
 * has to name all of them.
 *
 * The first design took only the LONGEST list per file, and a planted violation showed why that is
 * wrong: removing one name from one list of a file that has two left the suite green, because the
 * other list was still complete. That is the same symmetric-mistake shape this file exists for.
 *
 * A line that names an engine inside an EXPLANATION rather than in the list counts as naming it, which
 * is why README.md's SSL/TLS sentence passes: its list leaves OPC UA out, and the clause after it says
 * why, so the line as a whole names every engine and the reader is not misled.
 */
const FLEET_LIST_THRESHOLD = 28;

const fleetLists = (text: string): readonly string[] =>
  text.split("\n").filter((line) => namedIn(line).length >= FLEET_LIST_THRESHOLD);

describe("each README's numeral and its own engine list agree", () => {
  test("the population is the nine READMEs and the registry's own names", () => {
    // Asserted first: a short table or an empty name list would make every loop below vacuous.
    expect(READMES).toHaveLength(9);
    expect(ENGINE_NAMES.length).toBe(EXTERNAL_DATABASE_TYPES.length);
    expect(ENGINE_NAMES).toContain("MTConnect");
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

  test.each(READMES.map((entry) => [entry.file, entry] as const))(
    "%s carries today's numeral and not the last one",
    (_, entry) => {
      const text = read(entry.file);
      expect({ file: entry.file, says: text.includes(entry.now) }).toEqual({ file: entry.file, says: true });
      // The half-done move, which is the defect this file was written for: the numeral moved in one
      // file and the others kept the previous word while matching each other's lists.
      expect({ file: entry.file, stale: text.includes(entry.before) }).toEqual({ file: entry.file, stale: false });
    },
  );

  test("the numeral table is not vacuously satisfiable: today's word differs from the last one", () => {
    for (const entry of READMES) {
      expect({ file: entry.file, same: entry.now === entry.before }).toEqual({ file: entry.file, same: false });
    }
  });
});
