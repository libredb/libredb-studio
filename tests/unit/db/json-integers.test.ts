/**
 * 64-bit integers in JSON text (issue #265, design spec section 3)
 *
 * The scanner these tests cover started inside the Druid HTTP transport and moved
 * here because a SECOND parser needs it: Druid's EXPLAIN answers with columns that
 * are themselves JSON *text*, so the explain strategy parses one layer deeper than
 * the transport can reach, and an explain strategy must not import from a provider
 * directory (the rule `clickhouse-json.ts` records - it would tie the registry to
 * one provider). Both callers now import it from `@/lib/db/utils`.
 *
 * Every body replayed below was captured verbatim from Apache Druid 37.0.0, and the
 * hazard is pinned first: `JSON.parse` rounds a 64-bit literal silently, with no
 * error whatsoever.
 */
import { describe, expect, test } from "bun:test";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";

/**
 * `SELECT id, name, snowflake_id FROM libredb_demo WHERE region = ? LIMIT 1` as the
 * server returned it: three header rows and then the data, with the BIGINT unquoted
 * - the exact 2^53+1 value that `JSON.parse` rounds to ...992.
 */
const DRUID_SELECT_BODY =
  '[["id","name","snowflake_id"],["LONG","STRING","LONG"],["BIGINT","VARCHAR","BIGINT"],[1030,"alpha",9007199254740993]]';

/**
 * One EXPLAIN plan column, verbatim, for
 * `SELECT id FROM "libredb_demo" WHERE snowflake_id = 9007199254740993`. It is the
 * value of a JSON string, which is why the outer pass leaves its digits alone and
 * the inner parse has to run the scanner itself.
 */
const DRUID_PLAN_COLUMN =
  '[{"query":{"queryType":"scan","dataSource":{"type":"table","name":"libredb_demo"},' +
  '"filter":{"type":"equals","column":"snowflake_id","matchValueType":"LONG","matchValue":9007199254740993},' +
  '"columns":["id"]}}]';

describe("quoteUnsafeIntegers", () => {
  /** The exact value the live cluster returned for libredb_demo.snowflake_id. */
  const LIVE_UNSAFE = "9007199254740993";

  test("proves the hazard it exists for", () => {
    // Not a test of our code: a test of the reason it exists. If this ever stops
    // being true, the whole pass can go.
    expect(JSON.parse(`[${LIVE_UNSAFE}]`)).toEqual([9007199254740992]);
  });

  test("makes the live value survive JSON.parse exactly", () => {
    const parsed = JSON.parse(quoteUnsafeIntegers(DRUID_SELECT_BODY)) as unknown[][];

    expect(parsed[3][2]).toBe(LIVE_UNSAFE);
  });

  // The second caller's shape: a plan literal nested inside what was a JSON string
  // one layer up, which is the case the transport's own pass cannot reach.
  test("makes a plan literal survive the inner parse exactly", () => {
    const [entry] = JSON.parse(quoteUnsafeIntegers(DRUID_PLAN_COLUMN)) as [
      { query: { filter: { matchValue: unknown } } },
    ];

    expect(entry.query.filter.matchValue).toBe(LIVE_UNSAFE);
  });

  test.each<[string, string, string]>([
    ["an array element", `[${LIVE_UNSAFE}]`, `["${LIVE_UNSAFE}"]`],
    ["an object value", `{"a":${LIVE_UNSAFE}}`, `{"a":"${LIVE_UNSAFE}"}`],
    ["a value before a comma", `[${LIVE_UNSAFE},1]`, `["${LIVE_UNSAFE}",1]`],
    ["a value padded with spaces", `[ ${LIVE_UNSAFE} , 1 ]`, `[ "${LIVE_UNSAFE}" , 1 ]`],
    ["a value before a brace", `{"a":${LIVE_UNSAFE}}`, `{"a":"${LIVE_UNSAFE}"}`],
    ["a value before a newline", `[\n  ${LIVE_UNSAFE}\n]`, `[\n  "${LIVE_UNSAFE}"\n]`],
    ["a negative literal", "[-9007199254740993]", '["-9007199254740993"]'],
    ["every literal in the body", `[${LIVE_UNSAFE},9007199254740994]`, `["${LIVE_UNSAFE}","9007199254740994"]`],
    ["a much longer literal", "[18446744073709551615]", '["18446744073709551615"]'],
  ])("quotes %s", (_label, body, expected) => {
    expect(quoteUnsafeIntegers(body)).toBe(expected);
  });

  // The boundary is exactly Number.MIN_SAFE_INTEGER .. Number.MAX_SAFE_INTEGER:
  // inside it JSON.parse is exact, so rewriting would turn a number the grid can
  // sort into a string it cannot.
  test.each<[string, string]>([
    ["the largest safe integer", String(Number.MAX_SAFE_INTEGER)],
    ["the smallest safe integer", String(Number.MIN_SAFE_INTEGER)],
    ["a small integer", "1030"],
    ["zero", "0"],
    ["negative zero", "-0"],
    ["a float", "1.5"],
    ["a float beyond the safe range", "9007199254740993.5"],
    ["an exponent form", "1e999"],
    ["an integral exponent form", "9007199254740993e0"],
    ["a negative exponent form", "-1.5e-7"],
  ])("leaves %s untouched", (_label, literal) => {
    expect(quoteUnsafeIntegers(`[${literal}]`)).toBe(`[${literal}]`);
  });

  test.each<[string, string]>([
    ["the first integer outside the safe range", "9007199254740992"],
    ["the first integer below it", "-9007199254740992"],
  ])("quotes %s", (_label, literal) => {
    expect(quoteUnsafeIntegers(`[${literal}]`)).toBe(`["${literal}"]`);
  });

  // A string is the one place a digit run must never be touched: rewriting inside
  // one changes a value the user is reading, and would produce invalid JSON.
  test("never rewrites a digit run inside a string literal", () => {
    const body = `[["id: ${LIVE_UNSAFE}"]]`;

    expect(quoteUnsafeIntegers(body)).toBe(body);
  });

  // The desync that matters: reading `\"` as the end of the string would put the
  // scanner outside it, and the digits that follow would be rewritten inside a
  // string - invalid JSON, and a corrupted value on screen.
  test("an escaped quote does not desync the scanner", () => {
    const body = `[["a\\"${LIVE_UNSAFE}"],[${LIVE_UNSAFE}]]`;

    expect(quoteUnsafeIntegers(body)).toBe(`[["a\\"${LIVE_UNSAFE}"],["${LIVE_UNSAFE}"]]`);
  });

  test("an escaped backslash at the end of a string does not desync the scanner", () => {
    const body = `[["a\\\\",${LIVE_UNSAFE}]]`;

    expect(quoteUnsafeIntegers(body)).toBe(`[["a\\\\","${LIVE_UNSAFE}"]]`);
  });

  test.each<[string, string]>([
    ["a body with no literal at all", '[["a"],["STRING"],["VARCHAR"],["x"]]'],
    ["an empty body", ""],
    ["a body of only safe numbers", "[1,2,3]"],
  ])("returns %s unchanged", (_label, body) => {
    expect(quoteUnsafeIntegers(body)).toBe(body);
  });

  // A cancelled Druid query really does truncate its own body mid-value. The pass
  // runs before JSON.parse, so it has to walk one without throwing and leave the
  // parser to report the real problem.
  test.each<[string, string]>([
    ["a truncated string", `[["a"],["STRING"],["VARCHAR"],["gamm`],
    ["a truncated escape", `[["a\\`],
    ["a lone minus", "[-,1]"],
    ["a truncated unsafe literal", `[${LIVE_UNSAFE}`],
  ])("walks %s without throwing", (_label, body) => {
    expect(() => quoteUnsafeIntegers(body)).not.toThrow();
  });

  test("quotes a truncated literal it did reach the end of", () => {
    expect(quoteUnsafeIntegers(`[${LIVE_UNSAFE}`)).toBe(`["${LIVE_UNSAFE}"`);
  });
});
