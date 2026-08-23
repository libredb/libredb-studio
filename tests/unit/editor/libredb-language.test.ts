import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { registerLibreDBLanguage } from "@/lib/editor/libredb-language";

// ---------------------------------------------------------------------------
// Mock Monaco
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

// ---------------------------------------------------------------------------
// registerLibreDBLanguage
// ---------------------------------------------------------------------------

describe("registerLibreDBLanguage", () => {
  test("registers the libredb language with tokens provider and configuration", () => {
    const monaco = createMockMonaco();

    registerLibreDBLanguage(monaco);

    expect(monaco._state.registered).toEqual([{ id: "libredb" }]);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.tokensProviders[0]?.languageId).toBe("libredb");
    expect(monaco._state.configurations).toHaveLength(1);
    expect(monaco._state.configurations[0]?.languageId).toBe("libredb");
  });

  test("tokens provider declares the LibreDB verbs as case-insensitive keywords", () => {
    const monaco = createMockMonaco();

    registerLibreDBLanguage(monaco);

    const provider = monaco._state.tokensProviders[0]?.provider as Monaco.languages.IMonarchLanguage & {
      keywords: string[];
    };
    expect(provider.ignoreCase).toBe(true);
    expect(provider.keywords).toEqual(["get", "put", "delete", "prefix", "range"]);
    expect(provider.tokenizer.root.length).toBeGreaterThan(0);
  });

  // ── The Monarch rules themselves (U8) ─────────────────────────────────────
  //
  // The rules are DATA: loading this module covers every line of it, so the 100%
  // gate says nothing about whether a regex matches the right span. An unanchored
  // comment rule, a key split at its colon, or a new rule shadowing an older one
  // would pass every gate and be visible only in a browser. These assert the
  // regexes directly — no Monaco runtime involved.

  describe("tokenizer rules", () => {
    function rootRules() {
      const monaco = createMockMonaco();
      registerLibreDBLanguage(monaco);
      const provider = monaco._state.tokensProviders[0]!.provider;
      return provider.tokenizer.root as unknown as [RegExp, unknown][];
    }

    // Index by the token class each rule assigns so a reordering does not silently
    // repoint these assertions at a different rule.
    const COMMENT = 0;
    const DOUBLE_QUOTED = 1;
    const SINGLE_QUOTED = 2;
    const NUMBER = 3;
    const WORD = 4;

    test("the root state has exactly the five documented rules", () => {
      expect(rootRules()).toHaveLength(5);
    });

    test("the comment rule matches a `#` line and nothing after other data", () => {
      const [comment] = rootRules()[COMMENT]!;

      // The "Generate Command" cheatsheet header, and an indented one.
      expect(comment.test("# LibreDB commands for prefix users:")).toBe(true);
      expect(comment.test("    # indented")).toBe(true);
      expect(comment.test("#")).toBe(true);

      // Anchored: a `#` that follows data is DATA, matching the provider's line
      // skipper, which only skips a line whose first non-space character is `#`
      // (docs/providers/libredb.md §5.1).
      expect(comment.test('put note "line1 #tag"')).toBe(false);
      expect(comment.test("get user:1 # trailing")).toBe(false);
      expect(comment.test("put tag #value")).toBe(false);
    });

    test("a verb tokenizes through the keyword cases map, and only on an exact match", () => {
      const rules = rootRules();
      const [word, action] = rules[WORD]!;
      const anchored = new RegExp(`^(?:${word.source})`);

      expect(action).toEqual({ cases: { "@keywords": "keyword", "@default": "identifier" } });
      // The cases map keys off the WHOLE match, so the span the regex takes is what
      // decides keyword-vs-identifier: `get` is a verb, `getter` is a key.
      for (const verb of ["get", "put", "delete", "prefix", "range"]) {
        expect(anchored.exec(verb)?.[0]).toBe(verb);
      }
      expect(anchored.exec("getter")?.[0]).toBe("getter");
    });

    test("a key is ONE identifier token, not a verb split at the colon", () => {
      const [word] = rootRules()[WORD]!;
      const anchored = new RegExp(`^(?:${word.source})`);

      for (const key of ["users:1", "user:*", "session:abc:data", "cache.v2", "a/b", "my-key", "_internal"]) {
        expect(anchored.exec(key)?.[0]).toBe(key);
      }
      // `prefix users:` — the trailing colon belongs to the key token, not to a
      // separate operator token.
      expect(anchored.exec("users:")?.[0]).toBe("users:");
    });

    test("a range bound tokenizes as a number", () => {
      const rules = rootRules();
      const [number] = rules[NUMBER]!;
      const [word] = rules[WORD]!;

      for (const literal of ["0", "50", "1.5"]) {
        expect(new RegExp(`^(?:${number.source})`).exec(literal)?.[0]).toBe(literal);
        // Why the order between these two rules does not matter: the word rule
        // cannot open on a digit.
        expect(new RegExp(`^(?:${word.source})`).test(literal)).toBe(false);
      }
    });

    test("a quoted value is one string token, including a `#` inside it", () => {
      const rules = rootRules();
      const [double] = rules[DOUBLE_QUOTED]!;
      const [single] = rules[SINGLE_QUOTED]!;

      expect(double.exec('"line1 #tag"')?.[0]).toBe('"line1 #tag"');
      expect(double.exec('"esc \\" still inside"')?.[0]).toBe('"esc \\" still inside"');
      // The JSON value the cheatsheet emits for `put`.
      expect(single.exec('\'{"id":"example"}\'')?.[0]).toBe('\'{"id":"example"}\'');
      expect(single.exec("'a #b'")?.[0]).toBe("'a #b'");
      // A double-quoted rule must not swallow a single quote and vice versa.
      expect(double.test("'a'")).toBe(false);
      expect(single.test('"a"')).toBe(false);
    });

    // ── U10: this tokenizer deliberately has NO cross-line string state ───────
    //
    // The Redis tokenizer grew one, because that provider's `commandBody()` carries
    // quote state across the line break and stores a two-line value
    // (docs/providers/redis.md §3.4a). This provider does not: `firstCommandLine()`
    // takes the first non-comment LINE and `tokenize()` rejects an unmatched quote
    // (*"Unmatched quote in command"*, docs/providers/libredb.md §5.1), so no
    // quoted value can span a line break here. Carrying a string state across lines
    // would paint the rest of a cheatsheet as one value while the provider still
    // runs its first command — the same disagreement U10 is about, the other way
    // round.
    test("the tokenizer has a single root state: a quote never opens across a line", () => {
      const monaco = createMockMonaco();
      registerLibreDBLanguage(monaco);

      expect(Object.keys(monaco._state.tokensProviders[0]!.provider.tokenizer)).toEqual(["root"]);

      // Both quote rules match a whole single-line literal and push no state, so an
      // unterminated quote simply ends at the line break like every other rule.
      const rules = rootRules();
      for (const index of [DOUBLE_QUOTED, SINGLE_QUOTED]) {
        const [regex, action] = rules[index]!;
        expect(action).toBe("string");
        expect(regex.test('put note "line1')).toBe(false);
        expect(regex.test("put note 'line1")).toBe(false);
      }
    });

    // The ordering property the tokenizer relies on: no two rules can match at the
    // same position, so the list is order-independent today. A rule added with an
    // overlapping opening character would make order load-bearing silently.
    test("no two root rules can open on the same character", () => {
      const rules = rootRules();
      const openers = "#\"'0123456789aZ_*:{}[]() \t.-/".split("");

      for (const ch of openers) {
        const matching = rules.filter(([regex]) => new RegExp(`^(?:${regex.source})`, regex.flags).test(ch));
        expect(matching.length).toBeLessThanOrEqual(1);
      }
    });

    // ── Gaps this tokenizer has, asserted so a fix is visible as a failure ────

    test("a negative number is NOT one token: the sign is unmatched and the digits are the number", () => {
      const rules = rootRules();
      const [number] = rules[NUMBER]!;
      const anchoredNumber = new RegExp(`^(?:${number.source})`);

      // `\b\d+` cannot open on `-`, so `-1` paints as an unstyled `-` plus a number
      // `1`. Harmless for LibreDB, whose grammar (docs §5.1) has no negative
      // argument — recorded so a rule change shows up here rather than in a browser.
      expect(anchoredNumber.test("-1")).toBe(false);
      expect(anchoredNumber.exec("1")?.[0]).toBe("1");
    });

    test("a key that starts with a digit splits into a number and a leftover", () => {
      const rules = rootRules();
      const [number] = rules[NUMBER]!;
      const [word] = rules[WORD]!;

      // The word rule requires a letter or `_` start, so `2024:log` opens on the
      // number rule and only `2024` is consumed — `:log` is then matched by no rule.
      expect(new RegExp(`^(?:${number.source})`).exec("2024:log")?.[0]).toBe("2024");
      expect(new RegExp(`^(?:${word.source})`).test("2024:log")).toBe(false);
    });

    test("a bare `*` or a leading `:` matches no rule at all", () => {
      const rules = rootRules();

      // Unlike the Redis tokenizer, this one has no punctuation-led rule, so
      // `prefix *` paints `*` with Monaco's default token. Cosmetic only.
      for (const text of ["*", ":*", "-"]) {
        expect(rules.filter(([regex]) => new RegExp(`^(?:${regex.source})`, regex.flags).test(text))).toHaveLength(0);
      }
    });
  });

  test("language configuration uses # line comments and quote/bracket auto-closing pairs", () => {
    const monaco = createMockMonaco();

    registerLibreDBLanguage(monaco);

    const configuration = monaco._state.configurations[0]?.configuration;
    expect(configuration?.comments).toEqual({ lineComment: "#" });
    expect(configuration?.autoClosingPairs).toEqual([
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
    ]);
  });

  test("is idempotent: a second call no-ops once the language is registered", () => {
    const monaco = createMockMonaco();

    registerLibreDBLanguage(monaco);
    registerLibreDBLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.configurations).toHaveLength(1);
  });

  test("skips registration when another language with the libredb id already exists", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "libredb" });

    registerLibreDBLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(0);
    expect(monaco._state.configurations).toHaveLength(0);
  });
});
