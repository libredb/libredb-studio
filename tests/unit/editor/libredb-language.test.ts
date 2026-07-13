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
