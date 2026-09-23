/**
 * PromQL written from a name (#1085 section 3.6, #1085 S4)
 *
 * Every selector, matcher and label-values path segment the provider writes from a name comes out
 * of promql.ts, so this file is where a name built to break out of its selector is tried. Three
 * things are held here:
 *
 * - The reserved set is the lexer's word table at the tag. PROMQL_RESERVED_WORDS is pinned to
 *   tests/fixtures/prometheus/v3.13.3/lexer-words.json, the `key` table of promql/parser/lex.go at
 *   v3.13.3 with the two words init() keys as numbers, so a lexer that grows a keyword shows up as a
 *   failing test when the table is taken again, and not as a metric the tree cannot open.
 *   tests/fixtures/prometheus/v3.13.3/reserved-words.json is the evidence that the braces form
 *   metricSelector writes for each of those words is a selector: the live v3.13.3 server answered
 *   each with the vector or the matrix a selector gives in that context.
 * - Every name comes back out of what was written: exactly one selector, or exactly one path
 *   segment, holding exactly that name. The reading is done by rules written here in the engine's
 *   terms, never by the functions under test.
 * - Case does not matter to the lexer, so it does not matter here: SUM, Nan and Inf are as
 *   reserved as sum, nan and inf.
 */
import { describe, expect, test } from "bun:test";
import {
  ALL_METRICS_SELECTOR,
  escapeLabelNameForPath,
  isLegacyLabelName,
  isLegacyMetricName,
  labelMatcher,
  labelNotation,
  metricSelector,
  PROMQL_RESERVED_WORDS,
  seriesNotation,
} from "@/lib/db/providers/timeseries/prometheus/promql";
import { fixtureDocument } from "../../../helpers/prometheus-fixtures";

/** The part of the `lexer-words` fixture document this file reads. */
interface LexerWords {
  readonly words: readonly string[];
  readonly numberWords: readonly string[];
}

/**
 * One form of a word as the reserved-words probe sent it, and what the live server answered; `body`
 * is the verbatim text.
 */
interface WordForm {
  readonly expression: string;
  readonly status: number;
  readonly body: string;
}

/** The part of the `reserved-words` fixture document this file reads. */
interface ReservedWords {
  readonly contexts: readonly string[];
  readonly words: readonly {
    readonly word: string;
    readonly contexts: readonly { readonly context: string; readonly bare: WordForm; readonly braces: WordForm }[];
  }[];
}

/** Every word of the lexer's `key` table at v3.13.3 with its two number words, lowercased: the reserved set. */
function tableWords(): string[] {
  const lexer = fixtureDocument<LexerWords>("lexer-words");
  return [...new Set([...lexer.words, ...lexer.numberWords].map((word) => word.toLowerCase()))];
}

/**
 * The contexts the reserved-words probe asked every word in, in the order of the document's
 * `contexts` (alone, over a range, inside count, inside a subquery, then the word upper-cased
 * alone), each as the expression it wraps around a selector and the result type a selector
 * answers there.
 */
const WORD_CONTEXTS: Readonly<Record<string, readonly [wrap: (selector: string) => string, resultType: string]>> = {
  bare: [(selector) => selector, "vector"],
  range: [(selector) => `${selector}[5m]`, "matrix"],
  count: [(selector) => `count(${selector})`, "vector"],
  subquery: [(selector) => `rate(${selector}[5m])[1h:1m]`, "matrix"],
  upper: [(selector) => selector, "vector"],
};

/** A bare selector as the lexer reads one: a legacy metric name and nothing else. */
const BARE_SELECTOR = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/**
 * One `__name__` matcher holding one double-quoted string, every quote and backslash inside it
 * escaped, so nothing after the opening quote can close the string early.
 */
const ONE_NAME_MATCHER = /^\{__name__="(?:[^"\\]|\\.)*"\}$/;

/**
 * The name a selector selects, read the way the engine reads it, or a test failure when the text
 * is not exactly one selector: a bare word must be a legacy name that is no word of the lexer's
 * table, and anything else must be one `__name__` matcher whose string JSON reads back.
 */
function selectedName(selector: string): string {
  if (BARE_SELECTOR.test(selector)) {
    expect(tableWords()).not.toContain(selector.toLowerCase());
    return selector;
  }
  expect(selector).toMatch(ONE_NAME_MATCHER);
  return JSON.parse(selector.slice("{__name__=".length, -1)) as string;
}

// ============================================================================
// Legacy names
// ============================================================================

describe("isLegacyMetricName and isLegacyLabelName", () => {
  test("a legacy metric name may hold a colon anywhere, a legacy label name never", () => {
    for (const name of ["up", "job:up:sum", ":leading_colon", "_", "a1"]) expect(isLegacyMetricName(name)).toBe(true);
    for (const name of ["up", "__name__", "_", "a1"]) expect(isLegacyLabelName(name)).toBe(true);
    for (const name of ["job:up:sum", ":leading_colon"]) expect(isLegacyLabelName(name)).toBe(false);
  });

  test("neither admits a leading digit, punctuation, a space, a non-ASCII letter or an empty name", () => {
    for (const name of ["1a", "a.b", "a-b", "a b", "\u00e9", ""]) {
      expect(isLegacyMetricName(name)).toBe(false);
      expect(isLegacyLabelName(name)).toBe(false);
    }
    // The control: the same letters, joined legally.
    expect(isLegacyMetricName("a_b")).toBe(true);
    expect(isLegacyLabelName("a_b")).toBe(true);
  });

  // A pattern anchored with `$` must not match up to a trailing newline, or the name `up\n` would
  // be written bare and select `up`.
  test("a trailing newline makes a name not legacy", () => {
    expect(isLegacyMetricName("up\n")).toBe(false);
    expect(isLegacyLabelName("job\n")).toBe(false);
    expect(isLegacyMetricName("up")).toBe(true);
  });
});

// ============================================================================
// The reserved set, pinned to the lexer's table
// ============================================================================

describe("PROMQL_RESERVED_WORDS", () => {
  test("is exactly the lexer's word table at v3.13.3, with inf and nan", () => {
    expect([...PROMQL_RESERVED_WORDS].sort()).toEqual(tableWords().sort());
  });

  // The safety property: whatever a word does bare, the form metricSelector writes for it answered
  // as a selector on the live server, in every context the probe asked it in.
  test("writes every word as a form the live server answered as a selector", () => {
    const probe = fixtureDocument<ReservedWords>("reserved-words");

    // The controls: the probe asked every word of the table, each in every context.
    expect(probe.contexts).toEqual(Object.keys(WORD_CONTEXTS));
    expect(probe.words.map((row) => row.word).sort()).toEqual(tableWords().sort());
    for (const row of probe.words) {
      expect(row.contexts.map(({ context }) => context)).toEqual(Object.keys(WORD_CONTEXTS));
      for (const { context, braces } of row.contexts) {
        const [wrap, resultType] = WORD_CONTEXTS[context];
        const answer = JSON.parse(braces.body) as { status: string; data: { resultType: string } };

        expect(braces.expression).toBe(wrap(metricSelector(context === "upper" ? row.word.toUpperCase() : row.word)));
        expect([braces.status, answer.status, answer.data.resultType]).toEqual([200, "success", resultType]);
      }
    }
  });

  // The lexer lowercases a word before it looks it up, so the set holds lowercase words and every
  // lookup lowercases too.
  test("holds lowercase words only", () => {
    const words = [...PROMQL_RESERVED_WORDS];

    expect(words.filter((word) => word !== word.toLowerCase())).toEqual([]);
    // The control: the words the design names are in it.
    expect(words).toEqual(expect.arrayContaining(["sum", "by", "offset", "inf", "nan"]));
  });
});

// ============================================================================
// metricSelector
// ============================================================================

describe("metricSelector", () => {
  test("writes an ordinary legacy name bare", () => {
    for (const name of ["up", "prometheus_http_requests_total", "job:up:sum", ":leading_colon", "_"]) {
      expect(metricSelector(name)).toBe(name);
    }
  });

  // Bare, `nan` and `Inf` would evaluate as numbers. `sum` is reserved because it is a word of the
  // lexer's table, although v3.13.3 parses it bare.
  test("writes a reserved word as a __name__ matcher, whatever its case", () => {
    expect(metricSelector("nan")).toBe('{__name__="nan"}');
    expect(metricSelector("Nan")).toBe('{__name__="Nan"}');
    expect(metricSelector("Inf")).toBe('{__name__="Inf"}');
    expect(metricSelector("sum")).toBe('{__name__="sum"}');
    expect(metricSelector("SUM")).toBe('{__name__="SUM"}');
    expect(metricSelector("By")).toBe('{__name__="By"}');
  });

  test("reserves every word of the table in lower and in upper case", () => {
    for (const word of tableWords()) {
      expect(metricSelector(word)).toBe(`{__name__="${word}"}`);
      expect(metricSelector(word.toUpperCase())).toBe(`{__name__="${word.toUpperCase()}"}`);
    }
  });

  // Only a whole word is reserved: the lexer reads `summary` and `infinity` as identifiers.
  test("does not reserve a name that only starts with a reserved word", () => {
    for (const name of ["summary", "sum_over_time", "infinity", "nan2", "offset_seconds", "Byte"]) {
      expect(metricSelector(name)).toBe(name);
    }
  });

  test.each([
    "nan",
    "Inf",
    "sum",
    'a"b',
    "a\\b",
    "a\nb",
    'x"} or {__name__=~".+',
    "a&match[]=x",
    "a/../b",
    "service.name",
    "up",
  ])("%p is exactly one selector, of exactly that name", (name) => {
    expect(selectedName(metricSelector(name))).toBe(name);
  });

  // Go decodes a literal U+FFFD to utf8.RuneError, which lexString refuses inside any string, so the
  // one character JSON.stringify leaves alone is written as an escape the lexer accepts.
  test("escapes U+FFFD, which the lexer refuses as a literal", () => {
    const selector = metricSelector("a\uFFFDb");

    expect(selector).toBe('{__name__="a\\ufffdb"}');
    expect(selector).not.toContain("\uFFFD");
    expect(selectedName(selector)).toBe("a\uFFFDb");
  });

  test("ALL_METRICS_SELECTOR is one regex matcher on __name__", () => {
    // `.+`, not `.*`: a selector must hold one matcher that does not match the empty string.
    expect(ALL_METRICS_SELECTOR).toBe('{__name__=~".+"}');
  });
});

// ============================================================================
// Label notation
// ============================================================================

describe("labelNotation and labelMatcher", () => {
  // Inside braces the lexer reads a bare word as a label name without consulting its keyword
  // table, so `by`, `offset` and `nan` are ordinary label names there.
  test("writes a legacy label name bare, keywords included", () => {
    for (const name of ["job", "__name__", "by", "offset", "nan"]) expect(labelNotation(name)).toBe(name);
  });

  test("quotes any other label name, the form 3.x reads for a UTF-8 label", () => {
    expect(labelNotation("service.name")).toBe('"service.name"');
    expect(labelNotation("a:b")).toBe('"a:b"');
    expect(labelNotation('a"b')).toBe('"a\\"b"');
  });

  test("writes a matcher whose value is one string, however the value is built", () => {
    expect(labelMatcher("job", "api")).toBe('job="api"');
    expect(labelMatcher("service.name", "checkout")).toBe('"service.name"="checkout"');
    expect(labelMatcher("job", 'x"} or {job=~".+')).toBe('job="x\\"} or {job=~\\".+"');
    expect(labelMatcher("path", "a\\b\nc")).toBe('path="a\\\\b\\nc"');
    expect(labelMatcher("job", "a\uFFFDb")).toBe('job="a\\ufffdb"');
  });
});

describe("seriesNotation", () => {
  const labels = { __name__: "up", instance: "node-a:9100", job: "node" };

  test("writes the named labels in the order given", () => {
    expect(seriesNotation(labels, ["instance", "job"])).toBe('{instance="node-a:9100",job="node"}');
    expect(seriesNotation(labels, ["job", "instance"])).toBe('{job="node",instance="node-a:9100"}');
  });

  // PromQL's own meaning of absence: the engine stores no empty-valued label, and `name=""`
  // matches exactly the series that carry none.
  test('writes a label the series lacks as name=""', () => {
    expect(seriesNotation(labels, ["env", "job"])).toBe('{env="",job="node"}');
  });

  test("writes only the labels it is given", () => {
    expect(seriesNotation(labels, ["job"])).toBe('{job="node"}');
    expect(seriesNotation(labels, [])).toBe("{}");
  });

  // `constructor` is a legal label name and also a property every plain object inherits.
  test("reads a series' own labels, never an inherited property", () => {
    expect(seriesNotation(labels, ["constructor"])).toBe('{constructor=""}');
    // The control: a series that does carry it.
    expect(seriesNotation({ constructor: "yes" }, ["constructor"])).toBe('{constructor="yes"}');
  });
});

// ============================================================================
// Label-values path segments
// ============================================================================

/**
 * The label name the server reads out of a label-values path segment, transcribed from
 * web/api/v1/api.go (`labelValues`) and prometheus/common v0.69.0 model/metric.go (`UnescapeName`
 * with ValueEncodingEscaping), the module v3.13.3 pins. It lives here, in the server's terms, so a
 * round trip is judged by the server's rule and not by the encoder's own, and it keeps the upstream
 * quirk that an escape of six hex digits is never read: the `j >= 6` check comes first.
 */
function serverLabelName(segment: string): string {
  if (!segment.startsWith("U__")) return segment;
  const escaped = segment.slice("U__".length);
  let name = "";
  for (let i = 0; i < escaped.length; i++) {
    if (escaped.charAt(i) !== "_") {
      name += escaped.charAt(i);
      continue;
    }
    i++;
    if (i >= escaped.length) return segment;
    if (escaped.charAt(i) === "_") {
      name += "_";
      continue;
    }
    let codePoint = 0;
    for (let digits = 0; ; digits++, i++) {
      if (digits >= 6) return segment;
      if (escaped.charAt(i) === "_") break;
      const digit = Number.parseInt(escaped.charAt(i), 16);
      if (Number.isNaN(digit)) return segment;
      codePoint = codePoint * 16 + digit;
    }
    // utf8.ValidRune: five hex digits cannot pass U+10FFFF, so only a surrogate is left to refuse.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return segment;
    name += String.fromCodePoint(codePoint);
  }
  return name;
}

/** One path segment: letters, digits, `_` and `:`, so no `/`, `.`, `%`, `?`, `#`, `&` or `=`. */
const ONE_SEGMENT = /^[A-Za-z0-9_:]+$/;

describe("escapeLabelNameForPath", () => {
  test("leaves a legacy label name alone, and the server reads it as written", () => {
    for (const name of ["__name__", "job", "_", "U_", "u__lowercase"]) {
      expect(escapeLabelNameForPath(name)).toBe(name);
      expect(serverLabelName(name)).toBe(name);
    }
  });

  test("writes any other name in the upstream U__ value encoding", () => {
    expect(escapeLabelNameForPath("service.name")).toBe("U__service_2e_name");
    expect(escapeLabelNameForPath("a/../b")).toBe("U__a_2f__2e__2e__2f_b");
    expect(escapeLabelNameForPath("a&match[]=x")).toBe("U__a_26_match_5b__5d__3d_x");
    expect(escapeLabelNameForPath("1st")).toBe("U___31_st");
    expect(escapeLabelNameForPath("a:b")).toBe("U__a:b");
    expect(escapeLabelNameForPath("\u00e9")).toBe("U___e9_");
    expect(escapeLabelNameForPath("\u{1F600}")).toBe("U___1f600_");
  });

  // Upstream EscapeName returns `U__foo` unchanged, because it is a legacy name, and the server
  // would unescape it into `foo`: a request for another label.
  test("escapes a legacy name that starts with U__, which the server would otherwise unescape", () => {
    expect(serverLabelName("U__foo")).toBe("foo");
    expect(escapeLabelNameForPath("U__foo")).toBe("U__U____foo");
    expect(serverLabelName(escapeLabelNameForPath("U__foo"))).toBe("U__foo");
  });

  test.each([
    "__name__",
    "job",
    "_",
    "u__lowercase",
    "service.name",
    "a/../b",
    "a&match[]=x",
    'x"} or {__name__=~".+',
    "a\nb",
    'a"b',
    "a\\b",
    "1st",
    "a:b",
    "\u00e9",
    "\u65e5\u672c\u8a9e",
    "\u{1F600}",
    "U__foo",
    "U__",
    "U__a.b",
    "a\u{FFFFF}",
  ])("%p reaches the server as exactly one segment holding exactly that name", (name) => {
    const segment = escapeLabelNameForPath(name);

    expect(segment).toMatch(ONE_SEGMENT);
    expect(serverLabelName(segment)).toBe(name);
  });

  test("refuses a name the server could not read back, instead of asking for a label nobody has", () => {
    // UnescapeName gives up at a sixth hex digit, so the escape of U+100000 reads as this literal.
    expect(serverLabelName("U___100000_")).toBe("U___100000_");
    expect(() => escapeLabelNameForPath("a\u{100000}")).toThrow(RangeError);
    expect(() => escapeLabelNameForPath("a\uD800b")).toThrow(/cannot be sent in a label-values path/);
    // The control: the highest code point five hex digits hold goes through.
    expect(escapeLabelNameForPath("a\u{FFFFF}")).toBe("U__a_fffff_");
    expect(serverLabelName("U__a_fffff_")).toBe("a\u{FFFFF}");
  });
});
