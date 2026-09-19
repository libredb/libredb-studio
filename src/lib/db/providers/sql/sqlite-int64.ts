/**
 * SQLite's 64-bit integer boundary, shared by the SQLite driver and the libsql transport
 *
 * An integer past 2^53 cannot be held exactly by a JavaScript number, so both SQLite
 * providers read one out as its decimal STRING and hand the caller every digit. The
 * bind side must then convert exactly those strings back to a 64-bit integer and
 * nothing else, because a column with no type affinity never compares a string equal
 * to an integer: bound as text, `UPDATE ... WHERE id = ?` matches no row, reports 0
 * rows changed, and the editor tells the user nothing happened.
 *
 * This lives beside the providers rather than inside either of them because it is an
 * invariant BETWEEN them, and it was written twice before this file existed:
 * `MAX_INT64_BIGINT`, `MIN_SAFE_BIGINT`, the digit pattern and the predicate around
 * them stood in both `sqlite-driver.ts` and `libsql/hrana-transport.ts`, with the
 * second one's comment stating the coupling out loud - the two providers hand out the
 * same shape, so they must accept the same shape back. Two copies of a rule whose
 * whole content is "these two agree" can drift silently, and they had already begun
 * to: measured at cbca31d the two predicates behaved identically over 161 inputs
 * while their comments disagreed about whether exponent form was a shape the read can
 * print. `providers/sql/read-only-budget.ts` is the precedent followed here - one
 * small module in the SQL provider family, stated once, imported by each provider
 * that must obey it - and `tests/unit/db/sqlite-int64.test.ts` is what keeps a third
 * driver from quietly growing a copy of its own.
 *
 * It is NOT in `db/utils`: that home is for a rule no provider may own, which
 * `json-integers.ts` needed because a non-provider parser imports it too. Every
 * consumer here is a SQL provider, so the provider family is the narrowest home that
 * holds them both.
 *
 * Nothing here knows a wire format. Each provider still spells the converted value
 * its own way - `bun:sqlite` and `node:sqlite` take a real `bigint`, Hrana takes
 * `{ type: "integer", value: "<digits>" }` - and only the QUESTION is shared.
 */

/** The widest integer a JavaScript number holds exactly; past it a read prints digits. */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** SQLite's own INTEGER: signed 64-bit, and nothing wider can be stored in a row. */
const MAX_INT64_BIGINT = BigInt("9223372036854775807");
const MIN_INT64_BIGINT = BigInt("-9223372036854775808");

/**
 * The exact shape a 64-bit read prints: an optional minus, a non-zero first digit, at
 * most 19 digits in all (INT64's own width). Leading zeros, a leading `+`, surrounding
 * space, a decimal point, exponent form and the empty string all fall outside it.
 */
const SQLITE_INT64_DIGITS = /^-?[1-9][0-9]{0,18}$/;

/**
 * Whether this integer survives the trip through a JavaScript number unchanged.
 *
 * The read side's own switch: inside this range a provider hands the value back AS a
 * number, outside it as digits. The bind predicate below asks the same question from
 * the other end, which is why the bound is stated here once rather than in each.
 */
export function fitsJavaScriptNumber(value: bigint): boolean {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT;
}

/**
 * Whether these digits are ones a 64-bit read could itself have handed out, and so
 * must be bound back as the integer they came from.
 *
 * True for exactly one class of string: a 64-bit integer outside the safe range. That
 * makes the conversion the exact inverse of the read, and leaves every other string
 * alone - inside the safe range (`'1'`, `'9007199254740991'`) the read hands out a
 * NUMBER so such a string is the caller's own text; `'007'`, `'+7'`, `''`, `' 7'`,
 * `'7.0'`, `'9e15'` are shapes it cannot emit at all; and wider than 64 bits
 * (`'99999999999999999999'`) is not a value SQLite's INTEGER can hold, so no row could
 * match it as a number either.
 */
export function isSQLiteInt64Digits(param: string): boolean {
  if (!SQLITE_INT64_DIGITS.test(param)) return false;
  const parsed = BigInt(param);
  // Inside the safe range the read hands out a number, so digits are the caller's text.
  if (fitsJavaScriptNumber(parsed)) return false;
  return parsed >= MIN_INT64_BIGINT && parsed <= MAX_INT64_BIGINT;
}
