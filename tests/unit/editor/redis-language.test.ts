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

type Rule = [RegExp, unknown];

/**
 * A deliberately tiny model of the one Monarch behaviour U10 turns on: inside a
 * state the rules are tried in order and the first match wins, and the state
 * stack SURVIVES the line break. Nothing else about Monaco is simulated — the
 * assertions below are still about the rule data, in the style of the rest of
 * this file, but a multi-line claim needs the line break modelled to be stated
 * at all.
 */
function tokenizeLines(tokenizer: Record<string, Rule[]>, lines: string[]) {
  const stack = ["root"];
  return lines.map((line) => {
    const tokens: Array<{ token: string; text: string }> = [];
    let pos = 0;
    while (pos < line.length) {
      const rest = line.slice(pos);
      const rules = tokenizer[stack[stack.length - 1]!]!;
      let matched: { token: string; text: string } | undefined;
      for (const [regex, action] of rules) {
        const hit = new RegExp(`^(?:${regex.source})`, regex.flags).exec(rest);
        if (!hit || hit[0].length === 0) continue;
        const object = typeof action === "object" ? (action as { token?: string; next?: string }) : undefined;
        matched = { token: typeof action === "string" ? action : (object?.token ?? "@cases"), text: hit[0] };
        if (object?.next === "@pop") stack.pop();
        else if (object?.next) stack.push(object.next.slice(1));
        break;
      }
      // Monarch's own fallback when no rule matches: consume one character with
      // the default token and stay in the state.
      matched ??= { token: "", text: rest[0]! };
      tokens.push(matched);
      pos += matched.text.length;
    }
    return tokens;
  });
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
    function tokenizer() {
      const monaco = createMockMonaco();
      registerRedisLanguage(monaco);
      const provider = monaco._state.tokensProviders[0]!.provider;
      return provider.tokenizer as unknown as Record<string, Rule[]>;
    }

    function rootRules() {
      return tokenizer().root;
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

    test("a quoted value paints entirely as string, including a `#` inside it", () => {
      const rules = rootRules();
      const [double, doubleAction] = rules[DOUBLE_QUOTED]!;
      const [single, singleAction] = rules[SINGLE_QUOTED]!;

      // The opening quote is its own rule now (U10): it pushes the string state
      // instead of matching the whole literal, which is what lets the state
      // outlive the line.
      expect(double.source).toBe('"');
      expect(doubleAction).toEqual({ token: "string", next: "@doubleQuoted" });
      expect(single.source).toBe("'");
      expect(singleAction).toEqual({ token: "string", next: "@singleQuoted" });

      // Same span, same class as before: every token of the literal is `string`.
      for (const literal of ['"line1 #tag"', '"esc \\" still inside"', "'a #b'"]) {
        const [tokens] = tokenizeLines(tokenizer(), [literal]);
        expect(tokens!.map((t) => t.token)).toEqual(tokens!.map(() => "string"));
        expect(tokens!.map((t) => t.text).join("")).toBe(literal);
      }

      // A single quote inside a double-quoted value is data, and vice versa.
      const [mixed] = tokenizeLines(tokenizer(), ['"it\'s"']);
      expect(mixed!.map((t) => t.token)).toEqual(mixed!.map(() => "string"));
      expect(mixed!.map((t) => t.text).join("")).toBe('"it\'s"');
    });

    // ── U10: the string state survives the line break ─────────────────────────
    //
    // `commandBody()` treats a newline inside an open quoted argument as data —
    // `SET note "line1` / `#tag"` stores a two-line value and drops no comment
    // (docs/providers/redis.md §3.4a). The editor has to agree.

    test("the comment rule lives ONLY in the root state, so no string state can paint one", () => {
      const states = tokenizer();

      expect(Object.keys(states).sort()).toEqual(["doubleQuoted", "root", "singleQuoted"]);
      for (const [name, rules] of Object.entries(states)) {
        const comments = rules.filter(([, action]) => action === "comment");
        expect(comments).toHaveLength(name === "root" ? 1 : 0);
      }
    });

    test("a `#`-leading continuation line inside an open quote is a string, not a comment", () => {
      const [, continuation, after] = tokenizeLines(tokenizer(), ['SET note "line1', '#tag"', "# real comment"]);

      // The whole continuation line is the value, `#` included.
      expect(continuation!.map((t) => t.token)).toEqual(continuation!.map(() => "string"));
      expect(continuation!.map((t) => t.text).join("")).toBe('#tag"');
      // And the state popped with the closing quote: the next line is a comment
      // again, so the fix does not swallow the rest of the buffer.
      expect(after).toEqual([{ token: "comment", text: "# real comment" }]);
    });

    test("a closed quote leaves the state, so the next `#` line is still a comment", () => {
      const [first, second] = tokenizeLines(tokenizer(), ['SET note "line1 #tag"', "# header"]);

      expect(first!.some((t) => t.token === "comment")).toBe(false);
      expect(second).toEqual([{ token: "comment", text: "# header" }]);
    });

    // The ordering property the tokenizer relies on: no two rules can match at the
    // same position, so the list is order-independent today. A rule added with an
    // overlapping opening character would make order load-bearing silently.
    test("no two rules of a state can open on the same character", () => {
      const openers = "#\"'0-9aZ_*:{}[]() \t.\\".split("");

      // Holds for the string states too: their three rules open on
      // not-quote-not-backslash / backslash / the closing quote.
      for (const rules of Object.values(tokenizer())) {
        for (const ch of openers) {
          const matching = rules.filter(([regex]) => new RegExp(`^(?:${regex.source})`, regex.flags).test(ch));
          expect(matching.length).toBeLessThanOrEqual(1);
        }
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
