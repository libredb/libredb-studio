/**
 * PromQL written from a name (#1085 section 3.6, #1085 S4)
 *
 * The one builder for every PromQL fragment and label-values path segment this provider writes
 * from a name. The tree click and the snippets (src/lib/query-generators.ts), the wide matrix's
 * column names (results.ts) and the transport's label-values path (http-transport.ts) all come
 * through here, so a name built to break out of its selector is escaped once, by one rule, under
 * one test.
 *
 * Two facts about the v3.13.3 lexer decide the selector rule (promql/parser/lex.go, the `key`
 * table and `init()`):
 *
 * - It reads any word of that table as a keyword, looked up after lowercasing it (`fill`,
 *   `fill_left` and `fill_right` only before `(`). The v3.13.3 grammar takes most of those keywords
 *   back as a metric name (`sum`, `By` and `offset` parse bare there) but not `atan2`, `bool`, `on`,
 *   `ignoring`, `group_left` or `group_right`, and 2.x and MetricsQL differ, so the whole table is
 *   written as a `__name__` matcher: a superset of what v3.13.3 refuses bare.
 * - `init()` adds `inf` and `nan` to that table as numbers, so a legal metric named `nan` or `Inf`
 *   evaluates as a scalar: the query answers, with the wrong thing.
 *
 * Such a name, and any name that is not a legacy identifier, is written as a `__name__` matcher,
 * which parses on 2.x, 3.x and MetricsQL alike.
 *
 * This file imports nothing, because src/lib/query-generators.ts bundles it for the browser.
 */

/** A legacy metric name, the only kind the lexer reads as a bare selector. */
const LEGACY_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** A legacy label name: a metric name's alphabet without the colon. */
const LEGACY_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Every word of the `key` table of promql/parser/lex.go at v3.13.3, and the two words `init()`
 * keys as numbers, lowercased: a superset of the words the v3.13.3 grammar refuses bare.
 * Pinned by tests/unit/db/prometheus/promql.test.ts to tests/fixtures/prometheus/v3.13.3/lexer-words.json,
 * the table taken from the tag. tests/fixtures/prometheus/v3.13.3/reserved-words.json is the evidence
 * that the `__name__` matcher written for each of them is a selector, not the source of the set.
 */
export const PROMQL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  // Set operators, and the one binary operator spelled as a word.
  "and",
  "or",
  "unless",
  "atan2",
  // Aggregators.
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "group",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "count_values",
  "quantile",
  "limitk",
  "limit_ratio",
  // Keywords.
  "offset",
  "smoothed",
  "anchored",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "fill",
  "fill_left",
  "fill_right",
  "bool",
  // Duration preprocessors.
  "start",
  "end",
  "step",
  "range",
  "max_of",
  "min_of",
  // Lexed as numbers.
  "inf",
  "nan",
]);

/**
 * The selector for every metric (4.2). `.+` and not `.*`, because a selector must hold one matcher
 * that does not match the empty string.
 */
export const ALL_METRICS_SELECTOR = '{__name__=~".+"}';

export function isLegacyMetricName(name: string): boolean {
  return LEGACY_METRIC_NAME.test(name);
}

export function isLegacyLabelName(name: string): boolean {
  return LEGACY_LABEL_NAME.test(name);
}

/**
 * A PromQL double-quoted string holding exactly `text`.
 *
 * JSON.stringify is the escaper (#1085 S4): every escape it writes for well-formed text is one the
 * lexer reads back to the same text, and it is injective, so no two names share a selector or a
 * column. It leaves alone one character the lexer refuses as a literal: U+FFFD, which Go decodes to
 * utf8.RuneError and `lexString` rejects as "invalid UTF-8 rune". That one is written `\ufffd`,
 * which the lexer accepts and JSON reads back the same, so the text stays a JSON string of the same
 * name. A lone surrogate is not well-formed text: JSON.stringify writes it as an escape that
 * `lexEscape` refuses as an invalid code point, so a selector for a name holding one is refused as
 * a parse error, and never selects another metric.
 */
function promqlString(text: string): string {
  return JSON.stringify(text).replaceAll("\uFFFD", "\\ufffd");
}

/** The bare name when legacy and not reserved (case-insensitively); otherwise a `__name__` matcher. */
export function metricSelector(name: string): string {
  if (isLegacyMetricName(name) && !PROMQL_RESERVED_WORDS.has(name.toLowerCase())) return name;
  return `{__name__=${promqlString(name)}}`;
}

/**
 * A label name as a selector writes it: bare when legacy, quoted otherwise, the form 3.x reads for a
 * UTF-8 label name. Inside braces the lexer reads a bare word through `lexIdentifier`, which never
 * consults the keyword table, so `by` or `nan` needs no quoting there.
 */
export function labelNotation(name: string): string {
  return isLegacyLabelName(name) ? name : promqlString(name);
}

/** `name="value"`, both halves written by the rules above. */
export function labelMatcher(name: string, value: string): string {
  return `${labelNotation(name)}=${promqlString(value)}`;
}

/**
 * `{a="1",b="2"}` over `names`, in the order given: the wide matrix's column name (5.3).
 *
 * A label the series lacks is written `name=""`, which is PromQL's own meaning of absence: the
 * engine stores no empty-valued label, and `name=""` matches exactly the series without one.
 * Labels are read with Object.hasOwn, because a legal label name such as `constructor` is also a
 * property every plain object inherits.
 */
export function seriesNotation(labels: Readonly<Record<string, string>>, names: readonly string[]): string {
  const matchers = names.map((name) => labelMatcher(name, Object.hasOwn(labels, name) ? labels[name] : ""));
  return `{${matchers.join(",")}}`;
}

/** web/api/v1/api.go unescapes a label-values path segment that starts with this. */
const PATH_ESCAPE_PREFIX = "U__";

/**
 * The highest code point the server reads back from an escaped segment. `UnescapeName`
 * (prometheus/common v0.69.0, model/metric.go, the version v3.13.3 pins) gives up at a sixth hex
 * digit, because its `j >= 6` check runs before it looks for the closing underscore, so an escape
 * of U+100000 or above would reach the server as a literal `U__...` name that no series carries.
 */
const MAX_PATH_CODE_POINT = 0xfffff;

/**
 * A character an escaped segment writes as itself (model.isValidLegacyRune): a letter or a colon
 * anywhere, a digit after the first position.
 */
const PATH_CHARACTER = /^[a-zA-Z:]$/;
const PATH_DIGIT = /^[0-9]$/;

/**
 * The segment for a label name in a label-values path: unchanged when legacy and not starting with
 * `U__`, and otherwise the `U__` value encoding the server undoes (`EscapeName` with
 * `ValueEncodingEscaping`): `__` for `_`, a letter, a colon or a later digit as itself, and
 * `_<hex>_` for any other character.
 *
 * Two departures from `EscapeName`, which is not a path encoder:
 *
 * - It returns a legacy name that starts with `U__` unchanged, and the server would then unescape
 *   it into another name (`U__foo` into `foo`). Such a name is escaped here like any other.
 * - It writes what the server cannot read back: a code point above MAX_PATH_CODE_POINT, and an
 *   unpaired surrogate, which is no UTF-8 at all. Such a name is refused here with a RangeError,
 *   rather than sent as a request for a label that no series carries.
 *
 * A segment this returns holds only letters, digits, `_` and `:`, so no name can add a path
 * segment, a query or a fragment to the request.
 */
export function escapeLabelNameForPath(name: string): string {
  if (isLegacyLabelName(name) && !name.startsWith(PATH_ESCAPE_PREFIX)) return name;
  let segment = PATH_ESCAPE_PREFIX;
  let position = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint > MAX_PATH_CODE_POINT || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new RangeError(
        `The label name ${JSON.stringify(name)} cannot be sent in a label-values path: the server reads back no character above U+FFFFF and no unpaired surrogate.`,
      );
    }
    if (character === "_") segment += "__";
    else if (PATH_CHARACTER.test(character) || (position > 0 && PATH_DIGIT.test(character))) segment += character;
    else segment += `_${codePoint.toString(16)}_`;
    position += 1;
  }
  return segment;
}
