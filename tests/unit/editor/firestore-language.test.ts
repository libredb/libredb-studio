import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { FIRESTORE_CHAIN } from "@/lib/editor/firestore-completions";
import {
  FIRESTORE_LANGUAGE_ID,
  FIRESTORE_METHODS,
  FIRESTORE_MONARCH,
  registerFirestoreLanguage,
} from "@/lib/editor/firestore-language";

// A local mock, as every language test here keeps its own: a shared mock module is the documented
// `mock.module()` contamination trap in this repository.
function createMockMonaco() {
  const state = {
    registered: [] as { id: string }[],
    tokens: [] as { languageId: string; language: Monaco.languages.IMonarchLanguage }[],
    configurations: [] as { languageId: string; configuration: Monaco.languages.LanguageConfiguration }[],
  };
  const monaco = {
    languages: {
      getLanguages: () => state.registered,
      register: (language: { id: string }) => {
        state.registered.push(language);
      },
      setMonarchTokensProvider: (languageId: string, language: Monaco.languages.IMonarchLanguage) => {
        state.tokens.push({ languageId, language });
        return { dispose: () => {} };
      },
      setLanguageConfiguration: (languageId: string, configuration: Monaco.languages.LanguageConfiguration) => {
        state.configurations.push({ languageId, configuration });
        return { dispose: () => {} };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, state };
}

type Action = string | { token: string; next?: string } | { cases: Record<string, string> };
type Rule = [RegExp, Action];

/**
 * The Monarch behaviour these rules depend on and nothing more: in a state the rules are tried in order and the first
 * non-empty match at the position wins, `cases` picks by the language's own word lists, and the state stack survives
 * the line break.
 */
function tokenize(lines: readonly string[]): string[][] {
  const tokenizer = FIRESTORE_MONARCH.tokenizer as unknown as Record<string, Rule[]>;
  const stack = ["root"];
  return lines.map((line) => {
    const out: string[] = [];
    let position = 0;
    while (position < line.length) {
      const state = stack[stack.length - 1];
      let matched = false;
      for (const [regex, action] of tokenizer[state]) {
        const sticky = new RegExp(regex.source, "y");
        sticky.lastIndex = position;
        const match = sticky.exec(line);
        if (match === null || match[0].length === 0) continue;
        let token: string;
        if (typeof action === "string") token = action;
        else if ("cases" in action) {
          const list = Object.entries(action.cases).find(
            ([key]) => key !== "@default" && (FIRESTORE_MONARCH[key.slice(1)] as string[]).includes(match[0]),
          );
          token = list === undefined ? action.cases["@default"] : list[1];
        } else {
          token = action.token;
          if (action.next === "@pop") stack.pop();
          else if (action.next !== undefined) stack.push(action.next.slice(1));
        }
        if (token !== "") out.push(`${token}:${match[0]}`);
        position += match[0].length;
        matched = true;
        break;
      }
      if (!matched) throw new Error(`no rule matched at ${position} in ${state}: ${line}`);
    }
    return out;
  });
}

describe("registerFirestoreLanguage", () => {
  test("registers the firestore id, its Monarch grammar and its brackets and comments, once", () => {
    const { monaco, state } = createMockMonaco();
    registerFirestoreLanguage(monaco);
    registerFirestoreLanguage(monaco);
    expect(FIRESTORE_LANGUAGE_ID).toBe("firestore");
    expect(state.registered).toEqual([{ id: "firestore" }]);
    expect(state.tokens).toEqual([{ languageId: "firestore", language: FIRESTORE_MONARCH }]);
    expect(state.configurations).toHaveLength(1);
    expect(state.configurations[0].configuration.comments).toEqual({ lineComment: "//", blockComment: ["/*", "*/"] });
  });
});

describe("the firestore Monarch grammar", () => {
  test("colours a chain by the console lexer's token kinds", () => {
    expect(tokenize(['db.collection("users").where("age", ">=", 18).limit(10); // newest first'])).toEqual([
      [
        "keyword:db",
        "delimiter:.",
        "function:collection",
        "delimiter:(",
        'string:"',
        "string:users",
        'string:"',
        "delimiter:)",
        "delimiter:.",
        "function:where",
        "delimiter:(",
        'string:"',
        "string:age",
        'string:"',
        "delimiter:,",
        'string:"',
        "string:>=",
        'string:"',
        "delimiter:,",
        "number:18",
        "delimiter:)",
        "delimiter:.",
        "function:limit",
        "delimiter:(",
        "number:10",
        "delimiter:)",
        "delimiter:;",
        "comment:// newest first",
      ],
    ]);
  });

  test("names the namespace and the value constructors as types, and a signed number as one number", () => {
    expect(tokenize(["new admin.firestore.Timestamp(1, -2)"])).toEqual([
      [
        "keyword:new",
        "type:admin",
        "delimiter:.",
        "type:firestore",
        "delimiter:.",
        "type:Timestamp",
        "delimiter:(",
        "number:1",
        "delimiter:,",
        "number:-2",
        "delimiter:)",
      ],
    ]);
  });

  test("marks a `${` inside a template string, which the console refuses", () => {
    expect(tokenize(["db.collection(`a${b}`)"])).toEqual([
      [
        "keyword:db",
        "delimiter:.",
        "function:collection",
        "delimiter:(",
        "string:`",
        "string:a",
        "invalid:${",
        "string:b}",
        "string:`",
        "delimiter:)",
      ],
    ]);
  });

  test("keeps a block comment open across the line break, and marks a character the grammar has no token for", () => {
    expect(tokenize(["/* first", "second */ db", 'db.collection("a") = 1'])).toEqual([
      ["comment:/*", "comment: first"],
      ["comment:second ", "comment:*/", "keyword:db"],
      [
        "keyword:db",
        "delimiter:.",
        "function:collection",
        "delimiter:(",
        'string:"',
        "string:a",
        'string:"',
        "delimiter:)",
        "invalid:=",
        "number:1",
      ],
    ]);
  });

  test("colours every method the completion chain offers as a method", () => {
    const offered = new Set(Object.values(FIRESTORE_CHAIN).flatMap((next) => Object.keys(next)));
    for (const method of offered) expect(FIRESTORE_METHODS).toContain(method);
  });
});
