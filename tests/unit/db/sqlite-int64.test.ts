/**
 * SQLite's 64-bit integer boundary, and the guard that keeps it stated once (#42, #44)
 *
 * `src/lib/db/providers/sql/sqlite-int64.ts` exists because this rule was written
 * twice - once in `sqlite-driver.ts`, once in `libsql/hrana-transport.ts` - and the
 * second copy's comment stated the coupling out loud: the two providers hand out the
 * same shape, so they must accept the same shape back. Measured at cbca31d the two
 * predicates agreed over 161 inputs while their comments had already stopped agreeing
 * about whether exponent form was a shape the read can print. Prose drifts first, and
 * code follows.
 *
 * This file does three separate jobs, and the third is the one that was worth the
 * work:
 *
 * 1. The shared module's own table - what converts, and every shape that must stay
 *    text. The providers keep their own tables too, through their own surfaces; this
 *    one measures the rule itself.
 * 2. ONE table run through BOTH providers' public surfaces. A behaviour table cannot
 *    catch a copy - a correct copy passes it - but it does catch a provider that
 *    imports the module and then ignores it, and it is the only assertion that both
 *    providers still answer the same question after the extraction.
 * 3. A source guard, which is the part that scales. It parses every file under
 *    `src/lib/db/providers/` and fails the moment the 64-bit bind vocabulary appears
 *    anywhere but the shared module. That is what a third driver added next year runs
 *    into: writing its own `/^-?[1-9][0-9]{0,18}$/` is red before it is ever wrong.
 *
 * Why a source guard rather than a wider behaviour table: a new driver's own copy
 * would be CORRECT the day it was written, so no table of cases can see it - only the
 * duplication itself is visible, and only in the source. The guard reads the directory
 * from disk rather than from a list, so it covers a provider that does not exist yet.
 *
 * What the guard cannot see, stated plainly: a copy that spells the same bounds some
 * other way (`2n ** 63n - 1n`) passes it. The pair of import assertions below is the
 * cheap complement - the two known consumers must read the rule from the module, so
 * inlining a replacement is red even when the replacement is spelled freshly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { normalizeSQLiteBigInt, toSQLiteBindValue } from "@/lib/db/providers/sql/sqlite-driver";
import { fitsJavaScriptNumber, isSQLiteInt64Digits } from "@/lib/db/providers/sql/sqlite-int64";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

// ============================================================================
// The shapes, once
//
// Every row is measured against the shared module AND against both providers below,
// so the table is written here and nowhere else in this file.
// ============================================================================

/** A value the read can print as digits, so the bind must send it back as an integer. */
const CONVERTED: [label: string, digits: string][] = [
  ["2^53 exactly, the first value the read prints as digits", "9007199254740992"],
  ["the classic past-2^53 key", "9007199254740993"],
  ["its negative", "-9007199254740993"],
  ["2^53 negated", "-9007199254740992"],
  ["a wide but ordinary 19-digit key", "1234567890123456789"],
  ["INT64's maximum", "9223372036854775807"],
  ["INT64's minimum", "-9223372036854775808"],
];

/**
 * A value that must stay TEXT. Each is either a shape the read cannot print, or one
 * it prints as a NUMBER rather than digits - in both cases the string reaching the
 * bind is the caller's own text and converting it would break a textual key.
 */
const STAYS_TEXT: [label: string, value: string][] = [
  ["inside the safe range, where the read prints a number", "9007199254740991"],
  ["the safe range's negative edge", "-9007199254740991"],
  ["a small integer's digits", "7"],
  ["zero", "0"],
  ["a single leading zero", "007"],
  ["many leading zeros", "0009007199254740993"],
  ["a leading plus", "+9007199254740993"],
  ["a signed value with leading zeros", "-0009007199254740993"],
  ["leading whitespace", " 9007199254740993"],
  ["trailing whitespace", "9007199254740993 "],
  ["the empty string", ""],
  ["a lone minus", "-"],
  ["a trailing .0", "9007199254740993.0"],
  ["exponent form", "9e15"],
  ["exponent form spelled out in full", "9.007199254740993e15"],
  ["hexadecimal", "0x1fffffffffffff1"],
  ["digits with a tail", "9007199254740993x"],
  ["one past INT64's maximum", "9223372036854775808"],
  ["one past INT64's minimum", "-9223372036854775809"],
  ["twenty digits", "12345678901234567890"],
  ["far wider than 64 bits", "99999999999999999999"],
];

// ============================================================================
// 1. The rule itself
// ============================================================================

describe("isSQLiteInt64Digits()", () => {
  test.each(CONVERTED)("%s (%s) is a shape the read printed", (_label, digits) => {
    expect(isSQLiteInt64Digits(digits)).toBe(true);
  });

  test.each(STAYS_TEXT)("%s (%j) is not", (_label, value) => {
    expect(isSQLiteInt64Digits(value)).toBe(false);
  });

  // The predicate's whole claim is that it is the read's exact inverse, so the two are
  // composed here rather than sampled: whatever the read prints as DIGITS it accepts,
  // and whatever the read prints as a NUMBER it must refuse.
  test("accepts exactly what the read prints as digits, and nothing it prints as a number", () => {
    for (const [, digits] of CONVERTED) {
      const printed = normalizeSQLiteBigInt(BigInt(digits));
      expect(typeof printed).toBe("string");
      expect(isSQLiteInt64Digits(String(printed))).toBe(true);
    }
    for (const digits of ["0", "1", "-1", "9007199254740991", "-9007199254740991"]) {
      expect(typeof normalizeSQLiteBigInt(BigInt(digits))).toBe("number");
      expect(isSQLiteInt64Digits(digits)).toBe(false);
    }
  });

  // The 19-digit pattern admits values INT64 cannot hold (9999999999999999999 is
  // nineteen digits and past the maximum), so the bound check is not redundant.
  test("refuses a 19-digit value the pattern admits but a row cannot hold", () => {
    expect(isSQLiteInt64Digits("9999999999999999999")).toBe(false);
    expect(isSQLiteInt64Digits("-9999999999999999999")).toBe(false);
    expect(isSQLiteInt64Digits("9223372036854775807")).toBe(true);
  });
});

describe("fitsJavaScriptNumber()", () => {
  // Written as BigInt("...") rather than as a literal because tsconfig targets ES2017,
  // where a `123n` literal is a compile error.
  test.each([
    ["zero", "0", true],
    ["one", "1", true],
    ["the safe maximum", "9007199254740991", true],
    ["the safe minimum", "-9007199254740991", true],
    ["one past the safe maximum", "9007199254740992", false],
    ["one past the safe minimum", "-9007199254740992", false],
    ["INT64's maximum", "9223372036854775807", false],
    ["INT64's minimum", "-9223372036854775808", false],
  ] as [string, string, boolean][])("%s", (_label, digits, expected) => {
    expect(fitsJavaScriptNumber(BigInt(digits))).toBe(expected);
  });

  // The boundary is the one thing a copy gets wrong by one, so it is walked rather than
  // sampled, and checked against the runtime's own answer instead of a restated bound.
  // Note what a round trip would NOT catch: 2^53 survives `BigInt(Number(x))` exactly,
  // and is still unsafe, because 2^53 + 1 collapses onto it.
  test("admits a value exactly when the runtime calls it a safe integer", () => {
    const one = BigInt(1);
    const last = BigInt("9007199254740996");
    for (let value = BigInt("9007199254740988"); value <= last; value += one) {
      for (const signed of [value, -value]) {
        expect(fitsJavaScriptNumber(signed)).toBe(Number.isSafeInteger(Number(signed)));
      }
    }
  });
});

// ============================================================================
// 2. One table, both providers, through their own surfaces
//
// The SQLite driver's surface is `toSQLiteBindValue`, which answers a real `bigint`
// because that is what bun:sqlite and node:sqlite bind. The libSQL transport's
// surface is a request on the wire, which carries `{ type: "integer" }` because Hrana
// has no integers of its own. Different answers to the same question, which is why
// the question - and only the question - is the shared thing.
// ============================================================================

const LIBSQL: DatabaseType = "libsql" as unknown as DatabaseType;
const originalFetch = globalThis.fetch;
let sent: string[] = [];

/** The `args` of the statement in the nth request, as Hrana encoded them. */
function sentArgs(index = 0): Record<string, unknown>[] {
  const body = JSON.parse(sent[index] ?? "{}") as {
    requests?: { stmt?: { args?: Record<string, unknown>[] } }[];
  };
  return body.requests?.[0]?.stmt?.args ?? [];
}

/** One parameter bound through the real transport, and the wire value it produced. */
async function boundThroughHrana(value: string): Promise<Record<string, unknown> | undefined> {
  const connection: DatabaseConnection = {
    id: "libsql-int64",
    name: "libSQL invariant probe",
    type: LIBSQL,
    host: "127.0.0.1",
    port: 18081,
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
  };
  await new LibSQLHranaTransport(connection).execute("UPDATE t SET a = 1 WHERE id = ?", { params: [value] });
  return sentArgs(sent.length - 1)[0];
}

beforeEach(() => {
  sent = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          baton: null,
          base_url: null,
          results: [
            {
              type: "ok",
              response: {
                type: "execute",
                result: {
                  cols: [],
                  rows: [],
                  affected_row_count: 1,
                  last_insert_rowid: null,
                  rows_read: 0,
                  rows_written: 1,
                  query_duration_ms: 0.01,
                },
              },
            },
            { type: "ok", response: { type: "close" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("both SQLite providers accept back exactly what they hand out", () => {
  test.each(CONVERTED)("%s (%s) binds as an integer on the SQLite driver", (_label, digits) => {
    expect(toSQLiteBindValue(digits)).toBe(BigInt(digits));
  });

  test.each(CONVERTED)("%s (%s) binds as an integer on the libSQL transport", async (_label, digits) => {
    expect(await boundThroughHrana(digits)).toEqual({ type: "integer", value: digits });
  });

  test.each(STAYS_TEXT)("%s (%j) stays text on the SQLite driver", (_label, value) => {
    expect(toSQLiteBindValue(value)).toBe(value);
  });

  test.each(STAYS_TEXT)("%s (%j) stays text on the libSQL transport", async (_label, value) => {
    expect(await boundThroughHrana(value)).toEqual({ type: "text", value });
  });
});

// ============================================================================
// 3. The guard: the invariant may be spelled in exactly one file
// ============================================================================

const ROOT = `${import.meta.dir}/../../..`;
const PROVIDERS_DIR = `${ROOT}/src/lib/db/providers`;

/** The one file allowed to spell the boundary, relative to PROVIDERS_DIR. */
const HOME_FILE = "sql/sqlite-int64.ts";

const TOKEN_PATTERN = "the 19-digit read pattern";
const TOKEN_INT64 = "an INT64 bound";
const TOKEN_SAFE = "the safe-integer bound as a bigint";

/** Every token the guard looks for, and so every token its home must spell. */
const INVARIANT_VOCABULARY = [TOKEN_PATTERN, TOKEN_INT64, TOKEN_SAFE];

/** The regular expression's own source, as the read prints it. */
const READ_PATTERN_SOURCE = "[1-9][0-9]{0,18}";

/**
 * SQLite INTEGER's limits, matched as ANY literal. Both spellings of the ceiling are
 * listed because a copy may state the inclusive bound or the exclusive one, and
 * neither number has a use in a provider that is not this rule: a SQL string carrying
 * one would BE this rule, reimplemented in text.
 */
const INT64_BOUND_DIGITS = new Set(["9223372036854775807", "9223372036854775808"]);

/**
 * The 2^53 boundary, matched ONLY as a bigint - which is the difference between this
 * invariant and an ordinary ceiling. `read-only-budget.ts` admits a row count up to
 * `Number.MAX_SAFE_INTEGER` and `mssql.ts` discusses `SET ROWCOUNT 9007199254740991`;
 * neither is this rule, and a guard that reported them is a guard the next
 * contributor deletes. Converting the bound to a bigint is what makes it a comparison
 * against a 64-bit column value.
 */
const SAFE_BOUND_DIGITS = new Set(["9007199254740991", "9007199254740992"]);
const SAFE_BOUND_PROPERTIES = new Set(["MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER"]);

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see what they
 * are duplicating, otherwise the cheapest-looking fix is deleting the test.
 */
const INVARIANT_RULE = [
  `SQLite's 64-bit bind boundary was spelled outside ${HOME_FILE}.`,
  "",
  "An integer past 2^53 is read out of SQLite and libSQL as its decimal STRING, because a JavaScript",
  "number cannot hold it exactly. The bind side must convert exactly those strings back to a 64-bit",
  "integer and nothing else: a column with no type affinity never compares a string equal to an integer,",
  "so a text bind matches no row and `UPDATE ... WHERE id = ?` silently changes nothing. Both SQLite",
  "providers hand out the same shape, so they must accept the same shape back - which makes this an",
  "invariant BETWEEN providers, and two copies of it can drift without either one looking wrong.",
  "",
  `Import the predicate from providers/sql/sqlite-int64.ts instead of restating the bound, the pattern`,
  "or the safe-range comparison. If a new driver genuinely needs a different rule, that is a change to",
  "the shared module and to every provider at once, which is the conversation this guard is for. Do not",
  "weaken or delete this test: it is the only thing keeping one rule from becoming three.",
  "",
  "Spelled outside its home:",
].join("\n");

interface Duplication {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

/** A literal's digits, sign and BigInt suffix removed, or null when it is not one. */
function literalDigits(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text.replace(/^[-+]/, "");
  if (ts.isBigIntLiteral(node)) return node.text.replace(/n$/, "").replace(/^[-+]/, "");
  return null;
}

/** Whether this expression names the safe-integer bound, however it is spelled. */
function namesSafeBound(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) return SAFE_BOUND_PROPERTIES.has(node.name.text);
  if (ts.isPrefixUnaryExpression(node)) return namesSafeBound(node.operand);
  const digits = literalDigits(node);
  return digits !== null && SAFE_BOUND_DIGITS.has(digits);
}

/**
 * The invariant tokens this node spells.
 *
 * Comments are trivia rather than nodes, so prose about the boundary is deliberately
 * free - a provider SHOULD explain what its rows do with a 64-bit id. What may not
 * happen is code depending on the numbers.
 */
function spelledTokens(node: ts.Node): string[] {
  if (ts.isRegularExpressionLiteral(node) && node.text.includes(READ_PATTERN_SOURCE)) return [TOKEN_PATTERN];

  const digits = literalDigits(node);
  if (digits !== null && INT64_BOUND_DIGITS.has(digits)) return [TOKEN_INT64];

  // A bigint literal IS the bound as a bigint, with no BigInt() call to look inside.
  if (ts.isBigIntLiteral(node) && digits !== null && SAFE_BOUND_DIGITS.has(digits)) return [TOKEN_SAFE];

  const isBigIntCall =
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BigInt";
  if (isBigIntCall && node.arguments.length === 1 && namesSafeBound(node.arguments[0])) return [TOKEN_SAFE];

  return [];
}

function findDuplications(file: string, source: string): Duplication[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One report per line and token: `BigInt("9223372036854775807")` carries the token on
  // the string literal only, but a future spelling could nest two, and reporting the
  // same duplication twice reads like two problems.
  const found = new Map<string, Duplication>();

  const visit = (node: ts.Node): void => {
    for (const token of spelledTokens(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: lines[line].trim() });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * The local name `isSQLiteInt64Digits` is bound to in this file, and whether that name
 * is actually CALLED - or null when the file never imports the predicate at all.
 *
 * Parsed rather than grepped so an alias is not mistaken for a violation: importing it
 * as `bindRule` is a style choice, and a guard that reported it would be crying wolf.
 * What must not happen is the import disappearing, or surviving while the call site
 * moves to something local.
 */
function importsThePredicate(source: string): { local: string; called: boolean } | null {
  const sourceFile = ts.createSourceFile("provider.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let local: string | null = null;
  const called = new Set<string>();

  const readImport = (node: ts.ImportDeclaration): void => {
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.endsWith("/sqlite-int64")) return;

    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "isSQLiteInt64Digits") local = element.name.text;
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) readImport(node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return local === null ? null : { local, called: called.has(local) };
}

/** Empty when the invariant is stated once; the rule plus every spelling when not. */
function violationReport(found: Duplication[]): string {
  if (found.length === 0) return "";

  const offences = found.map((item) => `  ${item.file}:${item.line} spells ${item.token} -> ${item.snippet}`);
  return [INVARIANT_RULE, ...offences].join("\n");
}

/**
 * Every provider source, relative to PROVIDERS_DIR with forward slashes.
 *
 * Read from disk rather than from a list, so a provider added next year is covered
 * without anyone remembering to add it. Paths are built with a forward slash rather
 * than `join()`, which spells a path with backslashes on Windows - the comparison
 * against HOME_FILE below would then never match there.
 */
function providerSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(`${prefix}${entry}`);
    }
  };
  walk(PROVIDERS_DIR, "");
  return out;
}

function readProviderSource(file: string): string {
  return readFileSync(`${PROVIDERS_DIR}/${file}`, "utf8");
}

describe("SQLite's 64-bit bind boundary is stated once", () => {
  const sources = providerSources();

  test("the guard walks the whole provider tree, not a list", () => {
    expect(sources).toContain(HOME_FILE);
    expect(sources).toContain("sql/sqlite-driver.ts");
    expect(sources).toContain("sql/libsql/hrana-transport.ts");
    // Every provider family, so a copy in a non-SQL provider is caught too.
    expect(sources.length).toBeGreaterThan(20);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one, so
  // the file that is SUPPOSED to spell the boundary must light up every token.
  test.each(INVARIANT_VOCABULARY)("%s is spelled in its home, proving the detector reads real code", (token) => {
    const tokens = findDuplications(HOME_FILE, readProviderSource(HOME_FILE)).map((item) => item.token);

    expect(tokens).toContain(token);
  });

  test(`no provider but ${HOME_FILE} spells the boundary`, () => {
    const found = sources
      .filter((file) => file !== HOME_FILE)
      .flatMap((file) => findDuplications(file, readProviderSource(file)));

    expect(violationReport(found)).toBe("");
  });

  // The guard reads numbers, so a copy spelled `2n ** 63n - 1n` would slip past it.
  // These two assertions close the likeliest version of that: the providers that must
  // obey the rule have to read it from the module, so replacing the call with anything
  // at all is red.
  test.each(["sql/sqlite-driver.ts", "sql/libsql/hrana-transport.ts"])("%s reads the rule from the module", (file) => {
    // The import and the call, not the whole file: a `toContain` over 20 KB of source
    // prints 20 KB on failure, and nobody reads that far to find one missing import.
    expect(importsThePredicate(readProviderSource(file))).toEqual({ local: "isSQLiteInt64Digits", called: true });
  });
});

describe("the boundary guard's detector", () => {
  /**
   * Everything a compliant provider legitimately does: discuss the boundary in prose,
   * import the predicate, use the bare `Number.MAX_SAFE_INTEGER` as an unrelated
   * ceiling the way `read-only-budget.ts` does, and name the ROWCOUNT limit in SQL.
   * None of it is a duplication, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose is free: an id past 9007199254740991 is read out as digits, INT64 stops at
 * 9223372036854775807, and the pattern is /^-?[1-9][0-9]{0,18}$/.
 */
import { isSQLiteInt64Digits } from "../sqlite-int64";

const MAX_ROWS = Number.MAX_SAFE_INTEGER;
const ROWCOUNT = "SET ROWCOUNT 9007199254740991";

export function bind(param: unknown): unknown {
  return typeof param === "string" && isSQLiteInt64Digits(param) ? BigInt(param) : param;
}
export const limits = { MAX_ROWS, ROWCOUNT };
`;

  /** A driver added next year with a copy of the rule instead of an import. */
  const VIOLATING_SAMPLE = `
const MAX_INT64 = BigInt("9223372036854775807");
const MIN_INT64 = -9223372036854775808n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const DIGITS = /^-?[1-9][0-9]{0,18}$/;

export function toBindValue(param: string): string | bigint {
  if (!DIGITS.test(param)) return param;
  const parsed = BigInt(param);
  if (parsed <= MAX_SAFE) return param;
  return parsed >= MIN_INT64 && parsed <= MAX_INT64 ? parsed : param;
}
`;

  test("passes a provider that imports the rule and names the numbers only in prose", () => {
    expect(findDuplications("sql/newdb/driver.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("reports every spelling in a provider that copies the rule, with the reason attached", () => {
    const found = findDuplications("sql/newdb/driver.ts", VIOLATING_SAMPLE);

    expect(found.map((item) => item.token)).toEqual([TOKEN_INT64, TOKEN_INT64, TOKEN_SAFE, TOKEN_PATTERN]);
    expect(violationReport(found)).toContain("was spelled outside");
    expect(violationReport(found)).toContain("spells the 19-digit read pattern");
  });

  test("reads a bigint literal of the safe bound, the spelling that needs no BigInt() call", () => {
    const tokens = findDuplications("sql/newdb/driver.ts", "const SAFE = 9007199254740992n;\n").map(
      (item) => item.token,
    );

    expect(tokens).toEqual([TOKEN_SAFE]);
  });

  test("ignores a BigInt() call that converts something else entirely", () => {
    expect(findDuplications("sql/newdb/driver.ts", 'const id = BigInt(row.id);\nconst n = BigInt("12");\n')).toEqual(
      [],
    );
  });

  // The import layer, both directions. An alias is legitimate and must pass; losing the
  // import, or keeping it while the call site moves elsewhere, must not.
  test("accepts the predicate imported under an alias and called", () => {
    const aliased =
      'import { isSQLiteInt64Digits as bindRule } from "../sqlite-int64";\nexport const f = (p: string) => bindRule(p);\n';

    expect(importsThePredicate(aliased)).toEqual({ local: "bindRule", called: true });
  });

  test("reports a provider that imports the predicate and then calls something local", () => {
    const shadowed =
      'import { isSQLiteInt64Digits } from "../sqlite-int64";\nconst local = (p: string) => p !== "";\nexport const f = (p: string) => local(p);\n';

    expect(importsThePredicate(shadowed)).toEqual({ local: "isSQLiteInt64Digits", called: false });
  });

  test("reports a provider with no import of the rule at all", () => {
    expect(importsThePredicate('import { x } from "./other";\nexport const f = () => x;\n')).toBeNull();
  });
});
