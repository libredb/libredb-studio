import type * as Monaco from "monaco-editor";

/**
 * Monaco language for PromQL, the query language of the Prometheus provider (#1085).
 *
 * PromQL is neither SQL nor JSON, and either existing language misreads it: the SQL one reads a
 * `#` comment as code, a `[5m]` range as a bracketed identifier and a double-quoted label value as
 * a quoted identifier, and a PromQL expression is almost never valid JSON. This registers a
 * Monarch tokenizer whose tokens map onto the classes the shared studio themes colour
 * (`src/lib/editor/monaco-theme.ts`): aggregation operators, their modifiers, `offset` and `@` as
 * keywords, functions as functions, durations and numbers as numbers, the three string forms as
 * strings, and `#` comments. Metric and label names read as plain identifiers.
 *
 * The word lists are PromQL v3.13.3's, the version the provider is measured against: the lexer's
 * `key` map (`promql/parser/lex.go`) and the parser's `Functions` map
 * (`promql/parser/functions.go`). `tests/unit/editor/promql-language.test.ts` pins them to those two
 * files as captured at the tag, `tests/fixtures/prometheus/v3.13.3/lexer-words.json` and
 * `promql-functions.json`. A word a later version adds still tokenizes, as an identifier, so a stale
 * list costs a colour and never a wrong reading.
 *
 * The lexer reads keywords, aggregators, `inf` and `nan` in any case, so this language is
 * case-insensitive as well. Monarch applies that to every rule, which also colours a `RATE(` or a
 * `5M` the engine would refuse: a cosmetic overreach that never changes what is sent.
 *
 * The id must not be one the installed editor already registers: the guard below returns early
 * when it exists, which would leave Monaco's own tokenizer in charge.
 * `tests/isolated/monaco-language-ids.test.ts` pins that against the installed bundle.
 */
export const PROMQL_LANGUAGE_ID = "promql";

/** Aggregation operators, from the lexer's `key` map. */
const PROMQL_AGGREGATORS = [
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
];

/**
 * The lexer's set operators and keywords: the aggregation modifiers `by` and `without`, the
 * vector-matching modifiers, `bool`, `offset` and the two range-selector modifiers. `fill`,
 * `fill_left` and `fill_right` are absent on purpose: the lexer reads them as keywords only when a
 * `(` follows, which a word list cannot express, so they stay identifiers here.
 */
const PROMQL_KEYWORDS = [
  "and",
  "or",
  "unless",
  "atan2",
  "offset",
  "smoothed",
  "anchored",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "bool",
];

/**
 * The parser's functions. It includes the preprocessors `start`, `end`, `step`, `range`, `max_of`
 * and `min_of`, which the lexer also keys: they are only ever written as calls (`@ start()`,
 * `[step()]`), so they read as functions.
 */
const PROMQL_FUNCTIONS = [
  "abs",
  "absent",
  "absent_over_time",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "avg_over_time",
  "ceil",
  "changes",
  "clamp",
  "clamp_max",
  "clamp_min",
  "cos",
  "cosh",
  "count_over_time",
  "day_of_month",
  "day_of_week",
  "day_of_year",
  "days_in_month",
  "deg",
  "delta",
  "deriv",
  "double_exponential_smoothing",
  "end",
  "exp",
  "first_over_time",
  "floor",
  "histogram_avg",
  "histogram_count",
  "histogram_fraction",
  "histogram_quantile",
  "histogram_quantiles",
  "histogram_stddev",
  "histogram_stdvar",
  "histogram_sum",
  "hour",
  "idelta",
  "increase",
  "info",
  "irate",
  "label_join",
  "label_replace",
  "last_over_time",
  "ln",
  "log10",
  "log2",
  "mad_over_time",
  "max_of",
  "max_over_time",
  "min_of",
  "min_over_time",
  "minute",
  "month",
  "pi",
  "predict_linear",
  "present_over_time",
  "quantile_over_time",
  "rad",
  "range",
  "rate",
  "resets",
  "round",
  "scalar",
  "sgn",
  "sin",
  "sinh",
  "sort",
  "sort_by_label",
  "sort_by_label_desc",
  "sort_desc",
  "sqrt",
  "start",
  "stddev_over_time",
  "stdvar_over_time",
  "step",
  "sum_over_time",
  "tan",
  "tanh",
  "time",
  "timestamp",
  "ts_of_first_over_time",
  "ts_of_last_over_time",
  "ts_of_max_over_time",
  "ts_of_min_over_time",
  "vector",
  "year",
];

/** The two words the lexer reads as numbers. */
const PROMQL_NUMBER_WORDS = ["inf", "nan"];

/** A duration, `5m`, `500ms` or a chain such as `1h30m`: the lexer's units, `ms` tried before `m`. */
const DURATION = String.raw`(?:\d+(?:ms|[smhdwy]))+`;
/** A hex number, `0x1F`, with the `_` separators the lexer accepts. */
const HEX_NUMBER = String.raw`0[xX][\da-fA-F]+(?:_[\da-fA-F]+)*`;
/** A decimal number with an optional fraction, exponent and `_` separators, `.5` included. */
const DECIMAL_NUMBER = String.raw`(?:\d+(?:_\d+)*)?\.?\d+(?:_\d+)*(?:[eE][+-]?\d+)?`;

/**
 * ONE rule for all three, because all three open on a digit and separate rules would make their
 * order load-bearing. The duration is tried first so `5m` is not cut after its `5`. There is no
 * sign: the lexer reads a leading `-` or `+` as an operator.
 */
const NUMBER_OR_DURATION = new RegExp(`${DURATION}|${HEX_NUMBER}|${DECIMAL_NUMBER}`);

/**
 * Register the PromQL language on a Monaco instance. Idempotent: safe to call on every editor
 * mount, and a no-op once the language is registered.
 */
export function registerPromqlLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === PROMQL_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: PROMQL_LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(PROMQL_LANGUAGE_ID, {
    ignoreCase: true,
    aggregators: PROMQL_AGGREGATORS,
    keywords: PROMQL_KEYWORDS,
    functions: PROMQL_FUNCTIONS,
    numberWords: PROMQL_NUMBER_WORDS,
    tokenizer: {
      // Every rule of a state opens on text no other rule of that state opens on, so the order is
      // documentation rather than precedence; `tests/unit/editor/promql-language.test.ts` asserts
      // it with a probe per rule. The states follow the lexer's: statements, the inside of `{}`,
      // the inside of `[]`, and a raw string.
      root: [
        // `#` starts a comment to the end of the line wherever it stands outside a string, which
        // is the lexer's rule, so a trailing comment after an expression is one too.
        [/#.*$/, "comment"],
        // A double- or single-quoted string ends on its line: the lexer refuses a line break
        // inside one ("unterminated quoted string"), so neither may carry a state across lines.
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        // A raw string ends only at its closing backtick, line breaks included.
        [/`/, { token: "string", next: "@rawString" }],
        [/\{/, { token: "delimiter", next: "@braces" }],
        [/\[/, { token: "delimiter", next: "@range" }],
        [NUMBER_OR_DURATION, "number"],
        // A metric name may contain `:` (`job:rate5m:sum`) and may start with one.
        [
          /[a-zA-Z_:][\w:]*/,
          {
            cases: {
              "@aggregators": "keyword",
              "@keywords": "keyword",
              "@functions": "function",
              "@numberWords": "number",
              "@default": "identifier",
            },
          },
        ],
        // The `@` modifier reads with `offset`, as a keyword; `start()` and `end()` after it are
        // calls the functions list already covers.
        [/@/, "keyword"],
        [/[=!<>]=|=~|!~|[-+*/%^<>=]/, "operator"],
        [/[(),]/, "delimiter"],
      ],
      // Inside `{}` a word is a LABEL NAME, keywords included (`{by="x"}` names a label `by`), the
      // way the lexer's `lexIdentifier` reads it there; a label name has no `:`.
      braces: [
        [/#.*$/, "comment"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        [/`/, { token: "string", next: "@rawString" }],
        [/[a-zA-Z_]\w*/, "identifier"],
        [/=~|!~|!=|=/, "operator"],
        [/,/, "delimiter"],
        [/\}/, { token: "delimiter", next: "@pop" }],
      ],
      // Inside `[]`: a range or a subquery's range and step, which may be an arithmetic duration
      // expression with `step()` or `range()` in it. A `#` comment runs to the end of the line here
      // too: the lexer starts one anywhere after the first duration, because `lexNumberOrDuration`
      // hands back to `lexStatements`, and refuses one before it, which colours as a comment all
      // the same, the kind of cosmetic overreach the case-insensitivity above already makes.
      range: [
        [/#.*$/, "comment"],
        [NUMBER_OR_DURATION, "number"],
        [/:/, "delimiter"],
        [/[a-zA-Z_]\w*/, { cases: { "@functions": "function", "@default": "identifier" } }],
        [/[-+*/%^]/, "operator"],
        [/[(),]/, "delimiter"],
        [/\]/, { token: "delimiter", next: "@pop" }],
      ],
      rawString: [
        [/[^`]+/, "string"],
        [/`/, { token: "string", next: "@pop" }],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(PROMQL_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  });
}
