/**
 * The S3 Monaco language: registered once, every token role drawn as a token type the two
 * themes colour, and the state the tokens provider carries compared through the shared reader's own equality.
 */
import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INITIAL_SHELL_LINE_STATE } from "@/lib/db/console/shell-words";
import { registerS3Language, S3_LANGUAGE_ID, S3TokensState } from "@/lib/editor/s3-language";

// Mock Monaco: the harness of oxia-language.test.ts, kept local so no mock module is shared between test files.
interface MockMonacoState {
  registered: Monaco.languages.ILanguageExtensionPoint[];
  tokensProviders: Array<{ languageId: string; provider: Monaco.languages.TokensProvider }>;
  monarchProviders: string[];
  configurations: Array<{ languageId: string; configuration: Monaco.languages.LanguageConfiguration }>;
}

function createMockMonaco() {
  const state: MockMonacoState = { registered: [], tokensProviders: [], monarchProviders: [], configurations: [] };
  const mockMonaco = {
    languages: {
      getLanguages: () => state.registered,
      register: (language: Monaco.languages.ILanguageExtensionPoint) => {
        state.registered.push(language);
      },
      setTokensProvider: (languageId: string, provider: Monaco.languages.TokensProvider) => {
        state.tokensProviders.push({ languageId, provider });
        return { dispose: () => {} };
      },
      setMonarchTokensProvider: (languageId: string) => {
        state.monarchProviders.push(languageId);
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

function s3Provider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerS3Language(monaco);
  return monaco._state.tokensProviders[0].provider;
}

/** One line's tokens as `type:text`, read from `state`, with the state it leaves. */
function draw(
  provider: Monaco.languages.TokensProvider,
  line: string,
  state: Monaco.languages.IState = provider.getInitialState(),
): { readonly tokens: string[]; readonly after: S3TokensState } {
  const { tokens, endState } = provider.tokenize(line, state);
  const drawn = tokens.map((token, index) => {
    const end = index + 1 < tokens.length ? tokens[index + 1].startIndex : line.length;
    return `${token.scopes}:${line.slice(token.startIndex, end)}`;
  });
  return { tokens: drawn, after: endState as S3TokensState };
}

describe("registerS3Language", () => {
  test("registers the language once, with a tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerS3Language(monaco);
    registerS3Language(monaco);
    expect(S3_LANGUAGE_ID).toBe("s3");
    expect(monaco._state.registered).toEqual([{ id: "s3" }]);
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual(["s3"]);
    expect(monaco._state.monarchProviders).toEqual([]);
  });

  test("leaves a language already registered under the id alone", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "s3" });
    registerS3Language(monaco);
    expect(monaco._state.tokensProviders).toEqual([]);
    expect(monaco._state.configurations).toEqual([]);
  });

  test("comments start with #, and single and double quotes close themselves", () => {
    const monaco = createMockMonaco();
    registerS3Language(monaco);
    expect(monaco._state.configurations).toEqual([
      {
        languageId: "s3",
        configuration: {
          comments: { lineComment: "#" },
          autoClosingPairs: [
            { open: '"', close: '"' },
            { open: "'", close: "'" },
          ],
        },
      },
    ]);
  });
});

describe("the token type of each role", () => {
  test("lead as a comment, service and operation as keywords, flag as a function, path and string as strings", () => {
    expect(draw(s3Provider(), "$ aws s3api head-object --bucket b 'a b' s3://x $y # note").tokens).toEqual([
      "comment:$",
      ": ",
      "comment:aws",
      ": ",
      "keyword:s3api",
      ": ",
      "keyword:head-object",
      ": ",
      "function:--bucket",
      ": ",
      "identifier:b",
      ": ",
      "string:'a b'",
      ": ",
      "string:s3://x",
      ": ",
      "invalid:$",
      "identifier:y",
      ": ",
      "comment:# note",
    ]);
  });

  test("Studio's preview is drawn as a service, and a word past the eighth as a plain word", () => {
    expect(draw(s3Provider(), "preview s3://b/k").tokens).toEqual(["keyword:preview", ": ", "string:s3://b/k"]);
    const late = draw(
      s3Provider(),
      "aws --endpoint-url http://h:9000 --region r --output json --no-cli-pager s3api head-object",
    ).tokens;
    expect(late).toContain("identifier:s3api");
    expect(late).toContain("identifier:head-object");
  });

  test("starts from the shared reader's initial state, and carries an open quote to the next line", () => {
    const provider = s3Provider();
    const initial = provider.getInitialState() as S3TokensState;
    expect(initial).toBeInstanceOf(S3TokensState);
    expect(initial.lex).toBe(INITIAL_SHELL_LINE_STATE);
    const first = draw(provider, "aws s3api head-object --key 'a");
    expect(first.after.lex.quote).toBe("single");
    expect(draw(provider, "b'", first.after).tokens).toEqual(["string:b'"]);
  });

  test("states compare through the shared reader's equality, and a clone shares the reader's state", () => {
    const a = new S3TokensState(INITIAL_SHELL_LINE_STATE);
    expect(a.equals(new S3TokensState({ ...INITIAL_SHELL_LINE_STATE }))).toBe(true);
    expect(a.equals(new S3TokensState({ ...INITIAL_SHELL_LINE_STATE, quote: "double" }))).toBe(false);
    expect(a.equals({ clone: () => a, equals: () => true })).toBe(false);
    expect(a.clone().lex).toBe(a.lex);
  });
});
