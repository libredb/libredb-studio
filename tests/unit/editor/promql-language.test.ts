import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { PROMQL_LANGUAGE_ID, registerPromqlLanguage } from "@/lib/editor/promql-language";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";
import { fixtureDocument } from "../../helpers/prometheus-fixtures";

// ---------------------------------------------------------------------------
// Mock Monaco: a local copy of the harness in redis-language.test.ts, kept local for the
// reason that file gives, so no mock module is shared between test files.
// ---------------------------------------------------------------------------

interface MockMonacoState {
  registered: Monaco.languages.ILanguageExtensionPoint[];
  tokensProviders: Array<{ languageId: string; provider: Monaco.languages.IMonarchLanguage }>;
  configurations: Array<{ languageId: string; configuration: Monaco.languages.LanguageConfiguration }>;
}

function createMockMonaco() {
  const state: MockMonacoState = {
    registered: [],
    tokensProviders: [],
    configurations: [],
  };

  const mockMonaco = {
    languages: {
      getLanguages: () => state.registered,
      register: (language: Monaco.languages.ILanguageExtensionPoint) => {
        state.registered.push(language);
      },
      setMonarchTokensProvider: (languageId: string, provider: Monaco.languages.IMonarchLanguage) => {
        state.tokensProviders.push({ languageId, provider });
        return { dispose: () => {} };
      },
      setLanguageConfiguration: (languageId: string, configuration: Monaco.languages.LanguageConfiguration) => {
        state.configurations.push({ languageId, configuration });
        return { dispose: () => {} };
      },
    },
    _state: state,
  };

  return mockMonaco as unknown as typeof Monaco & { _state: MockMonacoState };
}

type MonarchAction =
  | string
  | { readonly token?: string; readonly next?: string; readonly cases?: Readonly<Record<string, string>> };
type Rule = readonly [RegExp, MonarchAction];
type Token = readonly [token: string, text: string];

/** The provider this module registers, with the word lists its `cases` read. */
type PromqlProvider = Monaco.languages.IMonarchLanguage & {
  readonly aggregators: readonly string[];
  readonly keywords: readonly string[];
  readonly functions: readonly string[];
  readonly numberWords: readonly string[];
};

function promqlProvider(): PromqlProvider {
  const monaco = createMockMonaco();
  registerPromqlLanguage(monaco);
  return monaco._state.tokensProviders[0]!.provider as PromqlProvider;
}

function statesOf(provider: PromqlProvider): Readonly<Record<string, readonly Rule[]>> {
  return provider.tokenizer as unknown as Readonly<Record<string, readonly Rule[]>>;
}

/**
 * `lexer-words`: the `key` map of `promql/parser/lex.go` at v3.13.3, grouped by the comments that
 * head its sections, and the words its `init()` keys as numbers. The part of the document the pin
 * below reads.
 */
interface LexerWords {
  readonly sections: readonly { readonly heading: string; readonly words: readonly string[] }[];
  readonly numberWords: readonly string[];
}

/** `promql-functions`: the keys of the `Functions` map of `promql/parser/functions.go` at v3.13.3. */
interface PromqlFunctions {
  readonly functions: readonly string[];
}

/** The words of one section of the lexer's `key` map, by its heading; a missing heading is refused by name. */
function lexerSection(lexer: LexerWords, heading: string): readonly string[] {
  const section = lexer.sections.find((candidate) => candidate.heading === heading);
  if (section === undefined) {
    const headings = lexer.sections.map((candidate) => candidate.heading).join(", ");
    throw new Error(`lexer-words has no "${heading}" section; its sections are ${headings}`);
  }
  return section.words;
}

/** A rule's regex the way Monarch applies it: anchored at the position, and case-insensitive when the language is. */
function anchored(provider: PromqlProvider, regex: RegExp): RegExp {
  return new RegExp(`^(?:${regex.source})`, provider.ignoreCase === true ? "i" : "");
}

/** The token a matched word takes: a plain action's own, or the first `cases` list that holds the word. */
function tokenOf(provider: PromqlProvider, action: MonarchAction, text: string): string {
  if (typeof action === "string") return action;
  if (action.cases === undefined) return action.token ?? "";
  for (const [key, token] of Object.entries(action.cases)) {
    if (key === "@default") return token;
    const words = (provider as unknown as Readonly<Record<string, readonly string[] | undefined>>)[key.slice(1)] ?? [];
    const holds =
      provider.ignoreCase === true
        ? words.some((word) => word.toLowerCase() === text.toLowerCase())
        : words.includes(text);
    if (holds) return token;
  }
  return "";
}

/**
 * A deliberately small model of Monarch, the one in redis-language.test.ts plus `cases`: inside a
 * state the rules are tried in order and the first non-empty match wins, the state stack survives
 * the line break, and a character no rule matches is consumed with the default token. The rules
 * are DATA, so loading the module covers every line of it and the coverage gate says nothing about
 * whether a regex matches the right span; these assertions are what does. Whitespace is dropped
 * from the result, because no rule here claims it.
 */
function tokenize(lines: readonly string[]): Token[][] {
  const provider = promqlProvider();
  const states = statesOf(provider);
  const stack = ["root"];
  return lines.map((line) => {
    const tokens: Token[] = [];
    let pos = 0;
    while (pos < line.length) {
      const rest = line.slice(pos);
      let matched: Token | undefined;
      for (const [regex, action] of states[stack[stack.length - 1]!]!) {
        const hit = anchored(provider, regex).exec(rest);
        if (hit === null || hit[0].length === 0) continue;
        matched = [tokenOf(provider, action, hit[0]), hit[0]];
        if (typeof action === "object" && action.next === "@pop") stack.pop();
        else if (typeof action === "object" && action.next !== undefined) stack.push(action.next.slice(1));
        break;
      }
      matched ??= ["", rest[0]!];
      tokens.push(matched);
      pos += matched[1].length;
    }
    return tokens.filter(([, text]) => text.trim() !== "");
  });
}

describe("registerPromqlLanguage", () => {
  test("registers the promql language with a tokens provider and a configuration", () => {
    const monaco = createMockMonaco();

    registerPromqlLanguage(monaco);

    expect(monaco._state.registered).toEqual([{ id: "promql" }]);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.tokensProviders[0]?.languageId).toBe("promql");
    expect(monaco._state.configurations).toHaveLength(1);
    expect(monaco._state.configurations[0]?.languageId).toBe("promql");
  });

  test("its id is the language a promql tab renders in", () => {
    expect(PROMQL_LANGUAGE_ID).toBe("promql");
    expect(editorLanguageForTabType("promql")).toBe(PROMQL_LANGUAGE_ID);
  });

  test("is idempotent: a second call no-ops once the language is registered", () => {
    const monaco = createMockMonaco();

    registerPromqlLanguage(monaco);
    registerPromqlLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.configurations).toHaveLength(1);
  });

  test("skips registration when another language with the promql id already exists", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "promql" });

    registerPromqlLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(0);
    expect(monaco._state.configurations).toHaveLength(0);
  });

  test("the configuration makes # the line comment and pairs every bracket and quote PromQL has", () => {
    const monaco = createMockMonaco();

    registerPromqlLanguage(monaco);

    const configuration = monaco._state.configurations[0]?.configuration;
    expect(configuration?.comments).toEqual({ lineComment: "#" });
    expect(configuration?.brackets).toEqual([
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ]);
    expect(configuration?.autoClosingPairs).toEqual([
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ]);
  });

  describe("tokenizer rules", () => {
    test("the lexer reads its words in any case, so the language does too", () => {
      expect(promqlProvider().ignoreCase).toBe(true);
    });

    test("the word lists hold the aggregations, modifiers and functions #1085 names, and fill stays out", () => {
      const provider = promqlProvider();
      for (const word of [
        "sum",
        "avg",
        "min",
        "max",
        "count",
        "group",
        "topk",
        "bottomk",
        "quantile",
        "count_values",
      ]) {
        expect(provider.aggregators).toContain(word);
      }
      for (const word of ["by", "without", "on", "ignoring", "group_left", "group_right", "bool", "offset"]) {
        expect(provider.keywords).toContain(word);
      }
      for (const word of ["and", "or", "unless"]) expect(provider.keywords).toContain(word);
      for (const word of ["rate", "irate", "increase", "histogram_quantile", "label_replace", "absent", "vector"]) {
        expect(provider.functions).toContain(word);
      }
      // `@ start()` and `@ end()` are calls, so the two preprocessors are functions here.
      expect(provider.functions).toContain("start");
      expect(provider.functions).toContain("end");
      expect(provider.numberWords).toEqual(["inf", "nan"]);
      // `fill`, `fill_left` and `fill_right` are keywords to the lexer only when a `(` follows,
      // which a word list cannot say, so they stay identifiers. The control is the list above.
      for (const word of ["fill", "fill_left", "fill_right"]) expect(provider.keywords).not.toContain(word);
    });

    // The lists are the lexer's and the parser's own words at v3.13.3, read from the two files as
    // captured at that tag (#1085 S4), so a list that drifts from the engine fails here rather than
    // miscolouring in silence.
    test("every word list is pinned to the v3.13.3 lexer and parser, with two stated exceptions", () => {
      const provider = promqlProvider();
      const lexer = fixtureDocument<LexerWords>("lexer-words");
      const { functions } = fixtureDocument<PromqlFunctions>("promql-functions");
      const sorted = (words: readonly string[]): string[] => [...words].sort();
      const FILL = ["fill", "fill_left", "fill_right"];
      const keywords = lexerSection(lexer, "Keywords");

      expect(sorted(provider.aggregators)).toEqual(sorted(lexerSection(lexer, "Aggregators")));
      // The set operators and `atan2` are the map's Operators, and the modifiers its Keywords.
      expect(sorted(provider.keywords)).toEqual(
        sorted([...lexerSection(lexer, "Operators"), ...keywords].filter((word) => !FILL.includes(word))),
      );
      // The first exception, asserted rather than assumed: the three fill words ARE lexer keywords,
      // left out of the list for the reason the test above gives.
      for (const word of FILL) expect(keywords).toContain(word);
      // Compared as sets, because the list is in code-unit order and the `Functions` map is not.
      expect(sorted(provider.functions)).toEqual(sorted(functions));
      // The second exception: the lexer keys the preprocessors too, and here they read as functions.
      for (const word of lexerSection(lexer, "Preprocessors")) expect(provider.functions).toContain(word);
      expect(provider.numberWords).toEqual(lexer.numberWords.map((word) => word.toLowerCase()));
    });

    test("no word is in two lists, so the cases map cannot depend on its own key order", () => {
      const provider = promqlProvider();
      const lists = {
        aggregators: provider.aggregators,
        keywords: provider.keywords,
        functions: provider.functions,
        numberWords: provider.numberWords,
      };
      const owner = new Map<string, string>();
      for (const [list, words] of Object.entries(lists)) {
        expect(words.length, list).toBeGreaterThan(0);
        for (const word of words) {
          expect(owner.get(word), `${word} is in ${owner.get(word)} and ${list}`).toBeUndefined();
          owner.set(word, list);
        }
      }
    });

    test("there are exactly four states, and a # comment lives in every one but the raw string", () => {
      const states = statesOf(promqlProvider());

      expect(Object.keys(states).sort()).toEqual(["braces", "range", "rawString", "root"]);
      const comments = Object.fromEntries(
        Object.entries(states).map(([name, rules]) => [
          name,
          rules.filter(([, action]) => action === "comment").length,
        ]),
      );
      // The lexer's own rule: `lexStatements` and `lexInsideBraces` start a comment at `#`, and so
      // does the inside of `[]` once its first duration is read, because `lexNumberOrDuration`
      // hands back to `lexStatements` there (v3.13.3 parses `x[5m # c` over a line break and `]`).
      // A raw string never does.
      expect(comments).toEqual({ root: 1, braces: 1, range: 1, rawString: 0 });
    });

    // Every rule of a state opens on text no other rule of that state can open on, so the rule
    // order is documentation rather than precedence. A probe matched by two rules would make the
    // order load-bearing in a way nothing on screen announces, and a probe matched by none would
    // be a construct this tokenizer silently gave up on.
    test("every probe is claimed by exactly one rule of its state", () => {
      const provider = promqlProvider();
      const states = statesOf(provider);
      const PROBES: Readonly<Record<string, readonly string[]>> = {
        root: [
          "# c",
          '"s"',
          "'s'",
          "`",
          "{",
          "[",
          "5m",
          "0x1F",
          ".5",
          "12",
          "sum",
          "rate",
          "up",
          ":job",
          "==",
          "!=",
          "=~",
          "<",
          "+",
          "@",
          "(",
          ")",
          ",",
        ],
        braces: ["# c", '"s"', "'s'", "`", "job", "=", "!=", "=~", "!~", ",", "}"],
        range: ["# c", "5m", "12", ":", "step", "+", "(", ")", ",", "]"],
        rawString: ["abc", "`"],
      };
      for (const [state, probes] of Object.entries(PROBES)) {
        for (const probe of probes) {
          const claimed = states[state]!.filter(([regex]) => {
            const hit = anchored(provider, regex).exec(probe);
            return hit !== null && hit[0].length > 0;
          });
          expect(claimed.length, `${state}: ${JSON.stringify(probe)}`).toBe(1);
        }
      }
    });

    test("an aggregation with its modifier, a function, a selector and a range", () => {
      expect(tokenize(['sum by (job) (rate(http_requests_total{job="api"}[5m]))'])).toEqual([
        [
          ["keyword", "sum"],
          ["keyword", "by"],
          ["delimiter", "("],
          ["identifier", "job"],
          ["delimiter", ")"],
          ["delimiter", "("],
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "http_requests_total"],
          ["delimiter", "{"],
          ["identifier", "job"],
          ["operator", "="],
          ["string", '"api"'],
          ["delimiter", "}"],
          ["delimiter", "["],
          ["number", "5m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
          ["delimiter", ")"],
        ],
      ]);
    });

    test("keywords and aggregators in upper case keep their class", () => {
      expect(tokenize(["SUM BY (job) (up OFFSET 5m)"])).toEqual([
        [
          ["keyword", "SUM"],
          ["keyword", "BY"],
          ["delimiter", "("],
          ["identifier", "job"],
          ["delimiter", ")"],
          ["delimiter", "("],
          ["identifier", "up"],
          ["keyword", "OFFSET"],
          ["number", "5m"],
          ["delimiter", ")"],
        ],
      ]);
    });

    test("inside braces a keyword is a label name, as the lexer reads it there", () => {
      // The control is the test above, where `by` and `offset` outside braces are keywords.
      expect(tokenize(['up{by="x", offset!~"y"}'])).toEqual([
        [
          ["identifier", "up"],
          ["delimiter", "{"],
          ["identifier", "by"],
          ["operator", "="],
          ["string", '"x"'],
          ["delimiter", ","],
          ["identifier", "offset"],
          ["operator", "!~"],
          ["string", '"y"'],
          ["delimiter", "}"],
        ],
      ]);
    });

    test("a duration is one number token, chained units included, and a subquery's colon is a delimiter", () => {
      expect(tokenize(["rate(x[1h30m])", "x[500ms]", "rate(x[5m])[1h:1m]", "x offset 1d", "x[2w]", "x[1y]"])).toEqual([
        [
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "1h30m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
        ],
        [
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "500ms"],
          ["delimiter", "]"],
        ],
        [
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "5m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
          ["delimiter", "["],
          ["number", "1h"],
          ["delimiter", ":"],
          ["number", "1m"],
          ["delimiter", "]"],
        ],
        [
          ["identifier", "x"],
          ["keyword", "offset"],
          ["number", "1d"],
        ],
        [
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "2w"],
          ["delimiter", "]"],
        ],
        [
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "1y"],
          ["delimiter", "]"],
        ],
      ]);
    });

    test("hex, decimal, exponent and separated numbers are one token each, and Inf and NaN are numbers", () => {
      expect(tokenize(["0x1F + .5 * 1e3 - 1_000 / 1.5", "vector(NaN) > -Inf"])).toEqual([
        [
          ["number", "0x1F"],
          ["operator", "+"],
          ["number", ".5"],
          ["operator", "*"],
          ["number", "1e3"],
          ["operator", "-"],
          ["number", "1_000"],
          ["operator", "/"],
          ["number", "1.5"],
        ],
        [
          ["function", "vector"],
          ["delimiter", "("],
          ["number", "NaN"],
          ["delimiter", ")"],
          ["operator", ">"],
          ["operator", "-"],
          ["number", "Inf"],
        ],
      ]);
    });

    test("@ takes start(), end() or a timestamp", () => {
      expect(tokenize(["up @ start()", "up @ end()", "http_requests_total @ 1609746000 offset 5m"])).toEqual([
        [
          ["identifier", "up"],
          ["keyword", "@"],
          ["function", "start"],
          ["delimiter", "("],
          ["delimiter", ")"],
        ],
        [
          ["identifier", "up"],
          ["keyword", "@"],
          ["function", "end"],
          ["delimiter", "("],
          ["delimiter", ")"],
        ],
        [
          ["identifier", "http_requests_total"],
          ["keyword", "@"],
          ["number", "1609746000"],
          ["keyword", "offset"],
          ["number", "5m"],
        ],
      ]);
    });

    test("all three string forms are strings, and only a backtick string runs across lines", () => {
      expect(tokenize(['label_replace(up, "dst", \'$1\', `src`, "(.*)")'])).toEqual([
        [
          ["function", "label_replace"],
          ["delimiter", "("],
          ["identifier", "up"],
          ["delimiter", ","],
          ["string", '"dst"'],
          ["delimiter", ","],
          ["string", "'$1'"],
          ["delimiter", ","],
          ["string", "`"],
          ["string", "src"],
          ["string", "`"],
          ["delimiter", ","],
          ["string", '"(.*)"'],
          ["delimiter", ")"],
        ],
      ]);
      // The lexer's raw string ends only at its closing backtick, so the state outlives the line,
      // and the braces the string sat in are still open after it.
      expect(tokenize(["up{job=`one", "two`}"])).toEqual([
        [
          ["identifier", "up"],
          ["delimiter", "{"],
          ["identifier", "job"],
          ["operator", "="],
          ["string", "`"],
          ["string", "one"],
        ],
        [
          ["string", "two"],
          ["string", "`"],
          ["delimiter", "}"],
        ],
      ]);
    });

    test("a double-quoted string never runs past its line, because the engine refuses one that does", () => {
      const [first, second] = tokenize(['up{job="one', 'two"}']);
      // The unclosed quote is left to the default token, and nothing on either line is a string.
      expect(first).toEqual([
        ["identifier", "up"],
        ["delimiter", "{"],
        ["identifier", "job"],
        ["operator", "="],
        ["", '"'],
        ["identifier", "one"],
      ]);
      expect(second).toEqual([
        ["identifier", "two"],
        ["", '"'],
        ["delimiter", "}"],
      ]);
    });

    test("a # comment runs to the end of the line after an expression and inside braces, but not inside a string", () => {
      expect(tokenize(["rate(x[5m]) # per second", 'up{job="a#b"}'])).toEqual([
        [
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "5m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
          ["comment", "# per second"],
        ],
        [
          ["identifier", "up"],
          ["delimiter", "{"],
          ["identifier", "job"],
          ["operator", "="],
          ["string", '"a#b"'],
          ["delimiter", "}"],
        ],
      ]);
      // A comment inside braces ends at the line, and the braces stay open for the next line.
      expect(tokenize(['up{job="api", # the job', 'instance="x"}'])).toEqual([
        [
          ["identifier", "up"],
          ["delimiter", "{"],
          ["identifier", "job"],
          ["operator", "="],
          ["string", '"api"'],
          ["delimiter", ","],
          ["comment", "# the job"],
        ],
        [
          ["identifier", "instance"],
          ["operator", "="],
          ["string", '"x"'],
          ["delimiter", "}"],
        ],
      ]);
    });

    test("inside a range or subquery bracket, a # comment after the duration runs to the end of the line", () => {
      // The engine reads one there, and the bracket stays open for the next line. The control is
      // the comment test above: the same rule, in the state a `[` opens.
      expect(tokenize(["rate(x[5m # five minutes", "])", "max_over_time(x[1h: # the window", "1m])"])).toEqual([
        [
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "5m"],
          ["comment", "# five minutes"],
        ],
        [
          ["delimiter", "]"],
          ["delimiter", ")"],
        ],
        [
          ["function", "max_over_time"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "1h"],
          ["delimiter", ":"],
          ["comment", "# the window"],
        ],
        [
          ["number", "1m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
        ],
      ]);
    });

    test("inside a subquery bracket, step() is a function", () => {
      expect(tokenize(["rate(x[5m])[1h:step()]"])).toEqual([
        [
          ["function", "rate"],
          ["delimiter", "("],
          ["identifier", "x"],
          ["delimiter", "["],
          ["number", "5m"],
          ["delimiter", "]"],
          ["delimiter", ")"],
          ["delimiter", "["],
          ["number", "1h"],
          ["delimiter", ":"],
          ["function", "step"],
          ["delimiter", "("],
          ["delimiter", ")"],
          ["delimiter", "]"],
        ],
      ]);
    });
  });
});
