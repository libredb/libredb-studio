/**
 * The console's totality (spec S11, 9). Over a corpus derived from the grammar's productions, mutated by token
 * insertions, deletions, swaps and truncations, and over random code units, the lexer, parser and compiler either
 * answer a statement or throw a QueryError positioned inside the text; and each bound fails with its own sentence
 * wherever the excess lands. The seed and the iteration count are fixed, so a failure replays.
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

/** Tokens a mutation inserts: grammar words, near-miss words, bad numbers, comment openers and stray characters. */
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

const CORPUS_TOKENS = CORPUS.map((text) =>
  lex(text)
    .filter((token) => token.kind !== "eof")
    .map((token) => token.text),
);

function mutate(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  if (random() < 0.1) {
    return Array.from({ length: Math.floor(random() * 64) }, () =>
      String.fromCharCode(Math.floor(random() * 0x10000)),
    ).join("");
  }
  const tokens = [...pick(CORPUS_TOKENS)];
  const edits = 1 + Math.floor(random() * 4);
  for (let edit = 0; edit < edits; edit++) {
    const at = Math.floor(random() * (tokens.length + 1));
    const kind = random();
    if (kind < 0.35) tokens.splice(at, 0, pick(POOL));
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

/** The property: a statement, or a QueryError whose position lies inside the text and whose message names it. */
function check(input: string, explainButton: boolean): void {
  try {
    compileStatement(parseStatement(input), input, { target: TARGET, explainButton });
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
      const random = seededRandom(SEED);
      for (let iteration = 0; iteration < ITERATIONS; iteration++) check(mutate(random), random() < 0.5);
    },
    BUDGET_MS,
  );

  test("each bound fails with its own sentence wherever the excess lands", () => {
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
