/**
 * The console's totality (spec S11, 9). Over a corpus derived from the grammar's productions, mutated by token
 * insertions, deletions, swaps and truncations, by control and rare code units placed inside its string literals and
 * comments, and over random code units, the lexer, parser and compiler either answer a statement or throw a QueryError
 * positioned inside the text; and each bound fails with its own sentence for any size of excess. The seed and the
 * iteration count are fixed, so a failure replays, and a planted lexer class bug proves the property can fail.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { compileStatement } from "@/lib/db/providers/document/firestore/console/compile";
import { LEXER_SENTENCES, lex } from "@/lib/db/providers/document/firestore/console/lexer";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { refusal, seededRandom, TARGET } from "../../../helpers/firestore-console";
import { platformTimeoutMs } from "../../../helpers/platform-timeout";

const SEED = 0x0f1e57;
const ITERATIONS = 20_000;
const BUDGET_MS = platformTimeoutMs(120_000);

/** One statement per production family of spec 5.4, each of which compiles. */
const CORPUS: readonly string[] = [
  'db.collection("users")',
  "await db.collection('users').where('age', '>=', 21).orderBy('age', 'desc').limit(10).get();",
  'db.collectionGroup("orders").where(FieldPath.documentId(), "==", "users/a/orders/o1")',
  'db.collection("c").where(Filter.or(Filter.where("a", "==", 1), Filter.and(Filter.where("b", "!=", null), Filter.where("c", "in", [1, 2]))))',
  'db.collection("c").orderBy(new FieldPath("a", "b")).startAfter(Timestamp.fromDate(new Date("2026-10-12"))).endAt(Timestamp.fromMillis(5))',
  'db.collection("c").where("g", "==", new admin.firestore.GeoPoint(1.5, -2)).select("a", "b.c")',
  'db.collection("c").where("t", ">", new Timestamp(1, 2)).offset(5).limit(1000)',
  'db.collection("c").where("r", "==", db.doc("c/d")).where("n", "==", NaN).where("i", "<", -Infinity)',
  'db.collection("c").findNearest({ vectorField: "e", queryVector: FieldValue.vector([1, 2.5e-3]), limit: 5, distanceMeasure: "COSINE", distanceResultField: "d", distanceThreshold: 0 })',
  'db.collection("c").aggregate({ n: AggregateField.count(), s: admin.firestore.AggregateField.sum("p"), a: AggregateField.average("p") }).get()',
  'db.collection("c").count().explain({ analyze: true })',
  'db.doc("c/d").listCollections()',
  "db.listCollections()",
  'db.collection("c").listDocuments()',
  'db.getAll(db.doc("c/a"), db.doc("c/b"))',
  'db.doc("c/d").collection("s").doc("x").get()',
  'db.collection("c").where("m", "==", { a: [1, "x", true, false], "b c": `t` }) // c\n/* d */',
];

/** Tokens a mutation inserts, with RARE: grammar and near-miss words, bad numbers, comment openers, stray characters. */
const POOL: readonly string[] = [
  "db",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  ";",
  "-",
  "=",
  '"x"',
  "'y'",
  "`z`",
  "`${`",
  '"a/b"',
  '"a:b"',
  '"__name__"',
  "1",
  "0",
  "-1",
  "1.5",
  "1e999",
  "9223372036854775808",
  "NaN",
  "Infinity",
  "null",
  "true",
  "new",
  "await",
  "const",
  "where",
  "Filter",
  "FieldPath",
  "FieldValue",
  "Timestamp",
  "AggregateField",
  "admin",
  "firestore",
  "then",
  "set",
  "collection",
  "doc",
  "count",
  "explain",
  "get",
  "/*",
  "//",
  "\\",
  "é",
  "\ud800",
  '"\\ud800"',
  "\n",
  "\u2028",
];

/** Control and rare code units that random strings rarely carry past their first character. */
const RARE: readonly string[] = [
  "\u0000",
  "\u0007",
  "\u001f",
  "\u007f",
  "\u0085",
  "\u00a0",
  "\ufeff",
  "\u2028",
  "\u2029",
  "\u{1f600}",
  "\udc00",
];

const INSERTED: readonly string[] = [...POOL, ...RARE];

const CORPUS_TOKENS = CORPUS.map((text) =>
  lex(text)
    .filter((token) => token.kind !== "eof")
    .map((token) => token.text),
);

/** Each corpus statement with the offsets inside its string literals and comments, where a code unit can land. */
const CORPUS_SLOTS = CORPUS.map((text) => {
  const slots: number[] = [];
  let previous = 0;
  for (const token of lex(text)) {
    for (const comment of text.slice(previous, token.start).matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
      const open = previous + comment.index + 2;
      const close = previous + comment.index + comment[0].length - (comment[0].startsWith("/*") ? 2 : 0);
      for (let at = open; at <= close; at++) slots.push(at);
    }
    if (token.kind === "string") for (let at = token.start + 1; at < token.end; at++) slots.push(at);
    previous = token.end;
  }
  return { text, slots };
}).filter(({ slots }) => slots.length > 0);

function mutate(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const unit = (): string => (random() < 0.5 ? pick(RARE) : String.fromCharCode(Math.floor(random() * 0x10000)));
  const branch = random();
  if (branch < 0.15) {
    const { text, slots } = pick(CORPUS_SLOTS);
    const at = pick(slots);
    return `${text.slice(0, at)}${unit()}${text.slice(at)}`;
  }
  if (branch < 0.25) {
    return Array.from({ length: Math.floor(random() * 64) }, () =>
      String.fromCharCode(Math.floor(random() * 0x10000)),
    ).join("");
  }
  const tokens = [...pick(CORPUS_TOKENS)];
  const edits = 1 + Math.floor(random() * 4);
  for (let edit = 0; edit < edits; edit++) {
    const at = Math.floor(random() * (tokens.length + 1));
    const kind = random();
    if (kind < 0.35) tokens.splice(at, 0, pick(INSERTED));
    else if (kind < 0.6) tokens.splice(at, 1);
    else if (kind < 0.85 && tokens.length > 1) {
      const other = Math.floor(random() * tokens.length);
      const swapped = tokens[Math.min(at, tokens.length - 1)];
      tokens[Math.min(at, tokens.length - 1)] = tokens[other];
      tokens[other] = swapped;
    } else tokens.splice(at, 0, pick(pick(CORPUS_TOKENS)));
  }
  const joined = tokens.join(random() < 0.5 ? " " : "");
  return random() < 0.2 ? joined.slice(0, Math.floor(random() * (joined.length + 1))) : joined;
}

/** The statement pipeline the property runs: lex and parse, then compile. */
type Pipeline = (input: string, explainButton: boolean) => unknown;

const PIPELINE: Pipeline = (input, explainButton) =>
  compileStatement(parseStatement(input), input, { target: TARGET, explainButton });

/** The property: a statement, or a QueryError whose position lies inside the text and whose message names it. */
function check(input: string, explainButton: boolean, pipeline: Pipeline): void {
  try {
    pipeline(input, explainButton);
  } catch (error) {
    if (!(error instanceof QueryError))
      throw new Error(`not a QueryError (${String(error)}) for ${JSON.stringify(input)}`, { cause: error });
    const { position } = error;
    const inside = position !== undefined && Number.isInteger(position) && position >= 0 && position <= input.length;
    if (!inside || !/ \(line \d+, column \d+: /.test(error.message)) {
      throw new Error(
        `an unpositioned refusal (${error.message}, at ${String(position)}) for ${JSON.stringify(input)}`,
        { cause: error },
      );
    }
  }
}

/** The fixed inputs: ITERATIONS mutated statements from SEED, each with its explain-button flag. */
function* generated(): Generator<readonly [string, boolean]> {
  const random = seededRandom(SEED);
  for (let iteration = 0; iteration < ITERATIONS; iteration++) yield [mutate(random), random() < 0.5];
}

/** How many of the inputs break the property under this pipeline. */
function violations(inputs: Iterable<readonly [string, boolean]>, pipeline: Pipeline): number {
  let count = 0;
  for (const [input, explainButton] of inputs) {
    try {
      check(input, explainButton, pipeline);
    } catch {
      count++;
    }
  }
  return count;
}

/** A planted lexer class bug: a TypeError for U+0007 inside a string literal, every other text lexed as written. */
const PLANTED: Pipeline = (input, explainButton) => {
  if (lex(input).some((token) => token.kind === "string" && token.text.includes("\u0007")))
    throw new TypeError("planted: U+0007 inside a string literal");
  return PIPELINE(input, explainButton);
};

describe("the console is total", () => {
  test("the corpus compiles as written", () => {
    for (const text of CORPUS) {
      expect(() =>
        compileStatement(parseStatement(text), text, { target: TARGET, explainButton: false }),
      ).not.toThrow();
    }
  });

  test(
    "only positioned QueryErrors over the mutated corpus and random code units",
    () => {
      let checked = 0;
      for (const [input, explainButton] of generated()) {
        check(input, explainButton, PIPELINE);
        checked++;
      }
      // check() throws on the first input that breaks the property, naming it; reaching here checked them all.
      expect(checked).toBe(ITERATIONS);
    },
    BUDGET_MS,
  );

  test(
    "the property catches a planted lexer class bug inside a string literal",
    () => {
      expect(violations([['db.collection("c\u0007")', false]], PLANTED)).toBe(1);
      expect(violations(generated(), PLANTED)).toBeGreaterThan(0);
    },
    BUDGET_MS,
  );

  test("each bound fails with its own sentence for any size of excess", () => {
    const random = seededRandom(SEED + 1);
    for (let iteration = 0; iteration < 20; iteration++) {
      const extra = 1 + Math.floor(random() * 100);
      const bytes = `db.collection("c")//${"x".repeat(65_536 - 20 + extra)}`;
      expect(refusal(() => parseStatement(bytes)).message.startsWith(LEXER_SENTENCES.tooLong)).toBe(true);
      const tokens = `db.collection("c").where("f", "in", [${"1,".repeat(5_000 + extra)}])`;
      expect(refusal(() => parseStatement(tokens)).message.startsWith(LEXER_SENTENCES.tooManyTokens)).toBe(true);
      const depth = 33 + Math.floor(random() * 10);
      const deep = `db.collection("c").where("f", "==", ${"[".repeat(depth)}${"]".repeat(depth)})`;
      expect(refusal(() => parseStatement(deep)).message.startsWith(LEXER_SENTENCES.tooDeep)).toBe(true);
    }
  });
});
