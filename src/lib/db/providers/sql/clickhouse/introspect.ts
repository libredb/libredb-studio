/**
 * ClickHouse schema introspection (issue #264, design spec section 3.6)
 *
 * Three reads of the `system.*` catalogs, all through the transport seam so this
 * file stays free of any wire vocabulary:
 *
 * - `system.tables` -> the table list, its row counts and sizes, and the two
 *   keys a MergeTree sorts by.
 * - `system.columns` -> columns in declaration order, with the declared type
 *   string, primary-key membership and the column default.
 * - `system.data_skipping_indices` -> the nearest thing ClickHouse has to a
 *   secondary index.
 *
 * Foreign keys are absent everywhere by construction: ClickHouse has none - no
 * engine, no table setting and no DDL declares one - so an empty list here is a
 * fact about the engine, not a load that failed or was deferred.
 *
 * Five things the live server (26.7.1.1315) forced, each load-bearing:
 *
 * 1. `total_rows`/`total_bytes` are `Nullable(UInt64)` and really are null for a
 *    view and for every non-MergeTree engine. Null is UNKNOWN, never zero.
 * 2. A `UInt64` arrives as a decimal STRING because the transport always sends
 *    64-bit quoting (spec 2.1), while a `UInt8` such as `is_in_primary_key`
 *    stays an unquoted number. Both encodings are accepted.
 * 3. A key expression is a comma-separated list that can itself contain commas -
 *    `a, b, cityHash64(c, c)` - and a one-element key keeps the parentheses a
 *    multi-element one drops: `(a)` versus `a, b`. Splitting has to be
 *    parenthesis-aware or a column ends up named `(a)` or `cityHash64(c`.
 * 4. `Nullable` is not always the outermost wrapper, and is not always the
 *    column's own: `LowCardinality(Nullable(String))` is nullable while
 *    `Array(Nullable(String))` is not.
 * 5. `system.tables` and `system.columns` are pre-filtered to what the user may
 *    read, but `system.data_skipping_indices` needs its own grant and answers
 *    500 / code 497 without it. Each catalog therefore degrades on its own.
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Databases holding the server's own bookkeeping rather than a user's data.
 *
 * `information_schema` exists twice, once in each case, and both are real
 * separate entries in `system.databases` (live-verified) - excluding one leaves
 * a duplicate of every ANSI catalog view in the tree. `default` is deliberately
 * NOT here: it is an ordinary writable database, and it is where a connection
 * that names none lands, so hiding it would empty the commonest setup.
 *
 * Exported because the monitoring reads (spec 3.7) filter `system.parts` by the
 * same rule, and one definition is the point.
 */
export const CLICKHOUSE_SYSTEM_DATABASES: readonly string[] = Object.freeze([
  "system",
  "information_schema",
  "INFORMATION_SCHEMA",
]);

/** The one wrapper ClickHouse puts outside `Nullable` instead of inside it. */
const LOW_CARDINALITY_PREFIX = "LowCardinality(";

const NULLABLE_PREFIX = "Nullable(";

/** The only `default_kind` that is an insert-time default rather than a computed column. */
const DEFAULT_KIND = "DEFAULT";

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Value readers
// ============================================================================

/** An identifier, or null for a row that cannot be placed and must be skipped. */
export function readIdentifier(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A `Nullable(UInt64)` count.
 *
 * Both encodings are real: the transport sends 64-bit quoting so nothing rounds
 * through `JSON.parse` (spec 2.1), which turns a `UInt64` into a decimal string,
 * while a source without that setting would send a number. Anything else -
 * null, an empty string, prose - is UNKNOWN and must stay undefined: a table
 * shown as "0 rows" when the server never said so is a number the explorer
 * invented, and a view reports null for exactly this field.
 */
export function readCount(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return value.length > 0 && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether the COLUMN accepts null, which is not the same as the type mentioning
 * `Nullable`. Live-verified: `Array(Nullable(String))`,
 * `Map(String, Nullable(String))` and `SimpleAggregateFunction(any,
 * Nullable(UInt64))` all qualify an inner type, so a substring search calls
 * three non-nullable columns nullable; `LowCardinality(Nullable(String))` is the
 * one combination spelled the other way round, so a bare prefix test misses it.
 */
export function isNullableType(type: string): boolean {
  const inner = type.startsWith(LOW_CARDINALITY_PREFIX) ? type.slice(LOW_CARDINALITY_PREFIX.length) : type;
  return inner.startsWith(NULLABLE_PREFIX);
}

/**
 * The column default as the explorer should show it.
 *
 * Live-verified kinds are `DEFAULT`, `MATERIALIZED`, `ALIAS` and `EPHEMERAL`
 * (the last confirmed while #269 gave the migration generator a ClickHouse
 * branch, which consumes these strings). Only the first
 * is a default an INSERT may override; the other three are not values the user
 * supplies — `MATERIALIZED` and `ALIAS` are computed, `EPHEMERAL` is insert-only
 * and never stored — so printing their expression bare would misread as one.
 */
export function readDefault(kind: string, expression: string): string | undefined {
  if (kind === "" || expression === "") return undefined;
  return kind === DEFAULT_KIND ? expression : `${kind} ${expression}`;
}

// ============================================================================
// Key expressions
// ============================================================================

/**
 * Drop one pair of parentheses when it wraps the whole expression.
 *
 * Live-verified rendering: a one-element key comes back as `(a)` while a
 * multi-element one comes back as `a, b`, and a data-skipping index over an
 * expression comes back as `(lower(b))`. The depth walk is what refuses
 * `(a), (b)`, where the first parenthesis closes long before the end.
 */
/** The quote characters ClickHouse opens a span with: identifiers, then literals. */
const QUOTES = new Set(["`", '"', "'"]);

/**
 * The index just past the quoted span opening at `open`.
 *
 * Needed because a quoted span may legally contain the very characters the scans
 * below treat as syntax: `` `region,code` `` is one identifier, and `` `a(b` ``
 * contains a parenthesis that must not move the depth counter. Both a backslash and
 * a doubled quote escape the quote rather than closing it. An unterminated span
 * consumes the rest of the string, which is the reading that cannot mis-split.
 */
function endOfQuoted(text: string, open: number): number {
  const quote = text[open];
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 1;
        continue;
      }
      return index + 1;
    }
  }
  return text.length;
}

function unwrapOuterParens(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;

  let depth = 0;
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (QUOTES.has(char)) {
      index = endOfQuoted(expression, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) return expression;
    }
    index += 1;
  }
  return expression.slice(1, -1).trim();
}

/**
 * Split a key or index expression into the elements it lists.
 *
 * Splitting on every comma is the trap: live-verified keys include
 * `a, b, cityHash64(c, c)` and `a, concat(b, 'x, y')`, both of which carry
 * commas that belong to a nested call, so only a top-level comma separates two
 * elements. Every comma that matters is outside every parenthesis, which is why
 * depth alone is enough and no lexer is needed.
 */
export function splitKeyExpression(expression: string): string[] {
  const listed = unwrapOuterParens(expression.trim());
  if (listed === "") return [];

  const elements: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < listed.length) {
    const char = listed[index];
    if (QUOTES.has(char)) {
      index = endOfQuoted(listed, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      elements.push(listed.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }
  elements.push(listed.slice(start).trim());
  return elements.filter((element) => element !== "");
}

// ============================================================================
// Row decoding
// ============================================================================

// ============================================================================
// Catalog reads
// ============================================================================

// ============================================================================
// Assembly
// ============================================================================

// ============================================================================
// Introspection
// ============================================================================
