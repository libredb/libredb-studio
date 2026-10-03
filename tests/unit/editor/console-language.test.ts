/**
 * One Monaco registration for every console dialect (vector-family spec 3.5), proven on a synthetic dialect: it
 * registers once across two mounts, tokenises with the console lexer, completes routes for its own id only, and
 * leaves the word-based fallback to Monaco where it has nothing to offer.
 */
import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INITIAL_CONSOLE_STATE } from "@/lib/db/console/lexer";
import { type ConsoleLanguage, ConsoleTokensState, registerConsoleLanguage } from "@/lib/editor/console-language";
import { QDRANT_ROUTES, QDRANT_STAND_IN } from "../../helpers/console-stand-ins";

interface MockState {
  registered: Monaco.languages.ILanguageExtensionPoint[];
  tokensProviders: { languageId: string; provider: Monaco.languages.TokensProvider }[];
  configurations: { languageId: string; configuration: Monaco.languages.LanguageConfiguration }[];
  completionProviders: { languageId: string; provider: Monaco.languages.CompletionItemProvider }[];
}

/** The harness of etcd-language.test.ts, kept local for the reason redis-language.test.ts gives, plus completions. */
function createMockMonaco() {
  const state: MockState = { registered: [], tokensProviders: [], configurations: [], completionProviders: [] };
  const monaco = {
    languages: {
      getLanguages: () => state.registered,
      register: (language: Monaco.languages.ILanguageExtensionPoint) => {
        state.registered.push(language);
      },
      setTokensProvider: (languageId: string, provider: Monaco.languages.TokensProvider) => {
        state.tokensProviders.push({ languageId, provider });
        return { dispose: () => {} };
      },
      setLanguageConfiguration: (languageId: string, configuration: Monaco.languages.LanguageConfiguration) => {
        state.configurations.push({ languageId, configuration });
        return { dispose: () => {} };
      },
      registerCompletionItemProvider: (languageId: string, provider: Monaco.languages.CompletionItemProvider) => {
        state.completionProviders.push({ languageId, provider });
        return { dispose: () => {} };
      },
      CompletionItemKind: { Value: 13 },
    },
    _state: state,
  };
  return monaco as unknown as typeof Monaco & { _state: MockState };
}

const SYNTHETIC: ConsoleLanguage = { spec: { ...QDRANT_STAND_IN, id: "synthetic-console" }, routes: QDRANT_ROUTES };

/** A text model of the given lines, as much of one as the completion provider reads. */
function model(lines: readonly string[]): Monaco.editor.ITextModel {
  return { getLineContent: (line: number) => lines[line - 1] } as unknown as Monaco.editor.ITextModel;
}

function complete(
  monaco: ReturnType<typeof createMockMonaco>,
  lines: readonly string[],
  lineNumber: number,
  column: number,
) {
  const { provider } = monaco._state.completionProviders[0];
  const result = provider.provideCompletionItems(
    model(lines),
    { lineNumber, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.CompletionList;
  return result.suggestions;
}

describe("registerConsoleLanguage", () => {
  test("registers the dialect's id once across two mounts, with one of each provider", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    registerConsoleLanguage(monaco, SYNTHETIC);
    expect(monaco._state.registered.map((language) => language.id)).toEqual(["synthetic-console"]);
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual(["synthetic-console"]);
    expect(monaco._state.configurations.map((entry) => entry.languageId)).toEqual(["synthetic-console"]);
    expect(monaco._state.completionProviders.map((entry) => entry.languageId)).toEqual(["synthetic-console"]);
  });

  test("two dialects register side by side, each under its own id", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    registerConsoleLanguage(monaco, { ...SYNTHETIC, spec: { ...SYNTHETIC.spec, id: "second-console" } });
    expect(monaco._state.completionProviders.map((entry) => entry.languageId)).toEqual([
      "synthetic-console",
      "second-console",
    ]);
  });

  test("the configuration holds the brackets and the dialect's first comment marker", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    const { configuration } = monaco._state.configurations[0];
    expect(configuration.comments).toEqual({ lineComment: "//" });
    expect(configuration.brackets).toEqual([
      ["{", "}"],
      ["[", "]"],
    ]);
  });

  test("a dialect with no comment marker declares no line comment", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, { ...SYNTHETIC, spec: { ...SYNTHETIC.spec, commentMarkers: [] } });
    expect(monaco._state.configurations[0].configuration.comments).toBeUndefined();
  });
});

describe("the tokens provider", () => {
  test("draws the console lexer's tokens line by line, carrying the lexer's state", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    const { provider } = monaco._state.tokensProviders[0];
    const initial = provider.getInitialState() as ConsoleTokensState;
    expect(initial.line).toBe(INITIAL_CONSOLE_STATE);
    const first = provider.tokenize("POST collections/docs/points/query", initial);
    expect(first.tokens.map((token) => token.scopes)).toEqual(["keyword", "", "function"]);
    const second = provider.tokenize('{"a": [1, "x"], "b": true} // n', first.endState);
    expect(second.tokens.map((token) => `${token.startIndex}:${token.scopes}`)).toEqual([
      "0:operator",
      "1:identifier",
      "4:operator",
      "5:",
      "6:operator",
      "7:number",
      "8:operator",
      "9:",
      "10:string",
      "13:operator",
      "14:operator",
      "15:",
      "16:identifier",
      "19:operator",
      "20:",
      "21:keyword",
      "25:operator",
      "26:",
      "27:comment",
    ]);
    expect((second.endState as ConsoleTokensState).line).toEqual({ section: "after-body", inString: false, depth: 0 });
  });

  test("a route of another table, and a method the dialect does not take, are drawn invalid", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, {
      ...SYNTHETIC,
      spec: { ...SYNTHETIC.spec, methods: ["POST"], commentMarkers: ["#"], bodyComments: false },
    });
    const { provider } = monaco._state.tokensProviders[0];
    const tokens = provider.tokenize("GET collections // x", provider.getInitialState()).tokens;
    expect(tokens.map((token) => token.scopes)).toEqual(["invalid", "", "function", "", "invalid"]);
  });

  test("states clone to an equal state and compare by value", () => {
    const state = new ConsoleTokensState({ section: "body", inString: false, depth: 2 });
    expect(state.clone().equals(state)).toBe(true);
    expect(state.equals(new ConsoleTokensState({ section: "body", inString: false, depth: 1 }))).toBe(false);
    expect(state.equals({ clone: () => state, equals: () => true })).toBe(false);
  });
});

describe("the route completion provider", () => {
  test("offers the method's routes after the method, replacing the partial route", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    const suggestions = complete(monaco, ["// list", "GET coll"], 2, 9);
    expect(suggestions.map((suggestion) => suggestion.insertText)).toEqual([
      "/",
      "collections",
      "collections/aliases",
      "collections/{collection_name}",
      "collections/{collection_name}/points/{id}",
      "collections/{collection_name}/optimizations",
    ]);
    expect(suggestions[1]).toEqual({
      label: "collections",
      kind: 13,
      insertText: "collections",
      range: { startLineNumber: 2, endLineNumber: 2, startColumn: 5, endColumn: 9 },
    });
  });

  test("offers nothing off the request line, before a method, or after a method the dialect does not take", () => {
    const monaco = createMockMonaco();
    registerConsoleLanguage(monaco, SYNTHETIC);
    expect(complete(monaco, ["GET collections", "GET "], 2, 5)).toEqual([]);
    expect(complete(monaco, ["GE"], 1, 3)).toEqual([]);
    expect(complete(monaco, ["PUT "], 1, 5)).toEqual([]);
  });
});
