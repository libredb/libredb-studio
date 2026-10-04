/**
 * Number-aware ordering for result columns (#1384).
 *
 * 64-bit integers and exact decimals cross the wire as strings of decimal places on purpose,
 * so a value past 2^53 keeps every one. TanStack's default comparison for a string is
 * lexicographic, which put `10` before `9` in every `bigint`, `numeric`, `Int64` and
 * `Decimal` column with nothing on screen saying the order was wrong.
 *
 * Nothing here converts to `Number`: a value is split into sign, integer part and
 * fraction part and compared place by place, which is exact for any width and scale.
 */

/**
 * A value ranked the way PostgreSQL orders floats: -Infinity, then every finite number,
 * then Infinity, then NaN. Whatever is not a number at all ranks after NaN.
 */
type Parsed = { rank: 0 | 2 | 3 | 4 } | { rank: 1; negative: boolean; int: string; frac: string };

const NOT_A_NUMBER: Parsed = { rank: 3 };
const NEGATIVE_INFINITY: Parsed = { rank: 0 };
const POSITIVE_INFINITY: Parsed = { rank: 2 };
const NOT_NUMERIC: Parsed = { rank: 4 };

const DECIMAL_STRING = /^([+-]?)(\d+|(?=\.\d))(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
/** An exponent past this is read as not a number rather than expanded into hundreds of places. */
const MAX_EXPONENT = 400;

/**
 * The declared types that hold a number. A word match on the lower-cased type, so the
 * dialect spellings (`bigint unsigned`, `Nullable(Int64)`, `numeric(12,2)`, `DECIMAL(18, 4)`,
 * `double precision`, `NUMBER`, `HUGEINT`, `varint`, `unsigned_long`, `BINARY_DOUBLE`, `DECFLOAT(34)`) all read
 * the same, and `interval`, `bytea` or `point` do not. `money` is left out: PostgreSQL sends it
 * formatted (`$1,234.50`), which is text.
 */
const NUMERIC_TYPE =
  /\b(u?(tiny|small|medium|big|huge)?int\d*|integer|uinteger|varint|counter|serial\d?|bigserial|smallserial|long|short|decimal\d*|dec|numeric|bignumeric|bignum|decfloat\d*|number|float\d*|double|real|smallmoney|binary_(double|float)|unsigned_long|half_float|scaled_float)\b/;
/** Containers and tagged types that merely mention a number (`int[]`, `Array(Int64)`, `row(int)`, `Enum8`) are not numbers; nor is Oracle's LONG text. */
const NON_NUMERIC_TYPE =
  /\[|\b(array|map|tuple|vector|set|list|struct|row|union|variant|nested|enum\d*|object)\b|\blong\s+(raw|varchar)\b/;

/** Whether `declared` names a numeric column type. */
export function isNumericType(declared: string): boolean {
  const type = declared.toLowerCase();
  return NUMERIC_TYPE.test(type) && !NON_NUMERIC_TYPE.test(type);
}

/** The exact decimal a plain or exponent spelling stands for, or NOT_NUMERIC when it is neither. */
function parseDecimalText(text: string): Parsed {
  const match = DECIMAL_STRING.exec(text.trim());
  if (match === null) return NOT_NUMERIC;
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (Math.abs(exponent) > MAX_EXPONENT) return NOT_NUMERIC;
  const places = match[2] + (match[3] ?? "");
  // Where the decimal point falls once the exponent has moved it.
  const point = match[2].length + exponent;
  const padded = point > places.length ? places + "0".repeat(point - places.length) : places;
  const lead = point < 0 ? "0".repeat(-point) + padded : padded;
  const split = Math.max(point, 0);
  const int = lead.slice(0, split).replace(/^0+(?=\d)/, "") || "0";
  const frac = lead.slice(split).replace(/0+$/, "");
  // -0 and -0.00 are zero: no sign, so they tie with 0 instead of sorting before it.
  return { rank: 1, negative: match[1] === "-" && (int !== "0" || frac !== ""), int, frac };
}

function parseValue(value: unknown): Parsed {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return NOT_A_NUMBER;
    if (!Number.isFinite(value)) return value < 0 ? NEGATIVE_INFINITY : POSITIVE_INFINITY;
    return parseDecimalText(String(value));
  }
  if (typeof value === "bigint") return parseDecimalText(String(value));
  if (typeof value !== "string") return NOT_NUMERIC;
  const word = value.trim().toLowerCase();
  if (word === "nan") return NOT_A_NUMBER;
  if (word === "infinity" || word === "+infinity") return POSITIVE_INFINITY;
  if (word === "-infinity") return NEGATIVE_INFINITY;
  return parseDecimalText(value);
}

/**
 * Whether a column sorts as numbers.
 *
 * A declared type decides when there is one, so a `varchar` of zip codes stays text. Only
 * a column that declares nothing falls back to its values: numeric when every non-null one
 * is a number or a decimal string.
 */
export function isNumericColumn(
  declared: string | undefined,
  rows: readonly Record<string, unknown>[],
  field: string,
): boolean {
  if (declared !== undefined) return isNumericType(declared);
  let seen = false;
  for (const row of rows) {
    const value = Object.hasOwn(row, field) ? row[field] : undefined;
    if (value === null || value === undefined) continue;
    if (parseValue(value).rank === 4) return false;
    seen = true;
  }
  return seen;
}

function compareMagnitude(a: { int: string; frac: string }, b: { int: string; frac: string }): number {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  if (a.frac === b.frac) return 0;
  return a.frac < b.frac ? -1 : 1;
}

/** Remembers what a string parsed to, so a sort of N rows parses each value once, not once per comparison. */
type ParseCache = Map<string, Parsed>;

function parseCached(value: unknown, cache: ParseCache | undefined): Parsed {
  if (cache === undefined || typeof value !== "string") return parseValue(value);
  let parsed = cache.get(value);
  if (parsed === undefined) {
    parsed = parseValue(value);
    cache.set(value, parsed);
  }
  return parsed;
}

/** Ascending order of two non-null values, exact for any width and scale. */
export function compareNumeric(a: unknown, b: unknown, cache?: ParseCache): number {
  // Two finite JS numbers are already exact to compare, and a float column is all of them.
  if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const left = parseCached(a, cache);
  const right = parseCached(b, cache);
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1;
  if (left.rank === 1 && right.rank === 1) {
    if (left.negative !== right.negative) return left.negative ? -1 : 1;
    const order = compareMagnitude(left, right);
    return left.negative ? -order : order;
  }
  if (left.rank === 4) {
    // Stray text is ordered among itself as text, so the order stays total.
    const textA = String(a);
    const textB = String(b);
    return textA === textB ? 0 : textA < textB ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two cells of a numeric column with NULLs in one place: after every value in both
 * directions. The table library inverts a comparator's result for a descending sort, so the
 * NULL answer is inverted here first to land where it started.
 *
 * `sortUndefined: "last"` would do this without the direction, but it only recognizes
 * `undefined` and a NULL cell is `null`.
 */
export function compareNumericCells(a: unknown, b: unknown, descending: boolean, cache?: ParseCache): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsAfter = aNull ? 1 : -1;
    return descending ? -nullsAfter : nullsAfter;
  }
  return compareNumeric(a, b, cache);
}

/** A comparator for one column that parses each distinct string once. */
export function numericCellComparator(): (a: unknown, b: unknown, descending: boolean) => number {
  const cache: ParseCache = new Map();
  return (a, b, descending) => compareNumericCells(a, b, descending, cache);
}
