import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { registerRedisLanguage } from "@/lib/editor/redis-language";

// ---------------------------------------------------------------------------
// Mock Monaco — a local copy of the harness in libredb-language.test.ts. Kept
// local on purpose: sharing a mock module across test files is the documented
// `mock.module()` contamination trap in this repo.
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

describe("registerRedisLanguage", () => {
  test("registers the redis language with tokens provider and configuration", () => {
    const monaco = createMockMonaco();

    registerRedisLanguage(monaco);

    expect(monaco._state.registered).toEqual([{ id: "redis" }]);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.tokensProviders[0]?.languageId).toBe("redis");
    expect(monaco._state.configurations).toHaveLength(1);
    expect(monaco._state.configurations[0]?.languageId).toBe("redis");
  });

  test("tokens provider declares case-insensitive verbs and argument modifiers", () => {
    const monaco = createMockMonaco();

    registerRedisLanguage(monaco);

    const provider = monaco._state.tokensProviders[0]?.provider as Monaco.languages.IMonarchLanguage & {
      keywords: string[];
      modifiers: string[];
    };
    expect(provider.ignoreCase).toBe(true);
    // Every verb the #427 generators can emit must tokenize as a keyword.
    for (const verb of [
      "SCAN",
      "TYPE",
      "GET",
      "SET",
      "TTL",
      "DEL",
      "HGETALL",
      "HSET",
      "LRANGE",
      "RPUSH",
      "SMEMBERS",
      "SADD",
      "ZRANGE",
      "ZADD",
    ]) {
      expect(provider.keywords).toContain(verb);
    }
    expect(provider.modifiers).toContain("MATCH");
    expect(provider.modifiers).toContain("COUNT");
    expect(provider.modifiers).toContain("WITHSCORES");
    // GET/SET/TYPE are verbs; keeping them out of the modifier list is what
    // avoids a cases-map collision.
    expect(provider.modifiers).not.toContain("GET");
    expect(provider.modifiers).not.toContain("SET");
    expect(provider.modifiers).not.toContain("TYPE");
    expect(provider.tokenizer.root.length).toBeGreaterThan(0);
  });

  // ── The Monarch rules themselves (#427) ───────────────────────────────────
  //
  // The rules are DATA: loading this module covers every line of it, so the 100%
  // gate says nothing about whether a regex matches the right span. A comment rule
  // that is not anchored, a cursor that tokenizes as an identifier, or a new rule
  // that shadows an older one would pass every gate and be visible only in a
  // browser. These assert the regexes directly — no Monaco runtime involved.

  describe("tokenizer rules", () => {
    function rootRules() {
      const monaco = createMockMonaco();
      registerRedisLanguage(monaco);
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
    const PUNCTUATION_LED = 5;

    test("the comment rule matches a `#` line and nothing after other data", () => {
      const [comment] = rootRules()[COMMENT]!;

      // The cheatsheet header the generators emit, and an indented one.
      expect(comment.test("# Redis commands for key prefix")).toBe(true);
      expect(comment.test("    # indented")).toBe(true);
      expect(comment.test("#")).toBe(true);

      // Anchored: a `#` that follows data is DATA, matching the provider's line
      // skipper, which only skips a line whose first non-space character is `#`.
      expect(comment.test('SET note "line1 #tag"')).toBe(false);
      expect(comment.test("GET user:1 # trailing")).toBe(false);
      expect(comment.test("SET tag #value")).toBe(false);
    });

    test("a SCAN cursor and a COUNT tokenize as numbers, never as identifiers", () => {
      const rules = rootRules();
      const [number] = rules[NUMBER]!;
      const [word] = rules[WORD]!;

      for (const literal of ["0", "50", "-1", "1.5"]) {
        expect(number.test(literal)).toBe(true);
        // The reason the order between these two does not matter: the word rule
        // cannot open on a digit or a minus sign.
        expect(new RegExp(`^(?:${word.source})`).test(literal)).toBe(false);
      }
    });

    test("a key pattern is ONE identifier token, not a command split at the colon", () => {
      const [word] = rootRules()[WORD]!;
      const anchored = new RegExp(`^(?:${word.source})`);

      for (const key of ["user:*", "session:abc:data", "cache.v2", "a/b", "my-key"]) {
        expect(anchored.exec(key)?.[0]).toBe(key);
      }
    });

    test("a pattern that opens on punctuation still reads as data", () => {
      const [punctuationLed] = rootRules()[PUNCTUATION_LED]!;
      const anchored = new RegExp(`^(?:${punctuationLed.source})`);

      expect(anchored.exec("*")?.[0]).toBe("*");
      expect(anchored.exec(":*")?.[0]).toBe(":*");
    });

    test("a quoted value is one string token, including a `#` inside it", () => {
      const rules = rootRules();
      const [double] = rules[DOUBLE_QUOTED]!;
      const [single] = rules[SINGLE_QUOTED]!;

      expect(double.exec('"line1 #tag"')?.[0]).toBe('"line1 #tag"');
      expect(double.exec('"esc \\" still inside"')?.[0]).toBe('"esc \\" still inside"');
      expect(single.exec("'a #b'")?.[0]).toBe("'a #b'");
      // A double-quoted rule must not swallow a single quote and vice versa.
      expect(double.test("'a'")).toBe(false);
      expect(single.test('"a"')).toBe(false);
    });

    // The ordering property the tokenizer relies on: no two rules can match at the
    // same position, so the list is order-independent today. A rule added with an
    // overlapping opening character would make order load-bearing silently.
    test("no two root rules can open on the same character", () => {
      const rules = rootRules();
      const openers = "#\"'0-9aZ_*:{}[]() \t.".split("");

      for (const ch of openers) {
        const matching = rules.filter(([regex]) => new RegExp(`^(?:${regex.source})`, regex.flags).test(ch));
        expect(matching.length).toBeLessThanOrEqual(1);
      }
    });
  });

  test("language configuration uses # line comments and quote/bracket auto-closing pairs", () => {
    const monaco = createMockMonaco();

    registerRedisLanguage(monaco);

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

    registerRedisLanguage(monaco);
    registerRedisLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(1);
    expect(monaco._state.configurations).toHaveLength(1);
  });

  test("skips registration when another language with the redis id already exists", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "redis" });

    registerRedisLanguage(monaco);

    expect(monaco._state.registered).toHaveLength(1);
    expect(monaco._state.tokensProviders).toHaveLength(0);
    expect(monaco._state.configurations).toHaveLength(0);
  });
});
