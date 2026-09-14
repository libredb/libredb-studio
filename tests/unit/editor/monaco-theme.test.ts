/**
 * The two studio editor themes have exactly one definition, and these tests are what
 * says so. Before #789 they were defined inside `QueryEditor`'s `beforeMount`, which is
 * per-mount state: a second Monaco mount that does not run that callback paints with
 * Monaco's stock theme and visibly does not match the query editor beside it.
 *
 * The full payloads are pinned rather than sampled. A hoist that changes one hex digit
 * is a visible regression, and nothing else in the repository would catch it: Monaco
 * accepts any colour map, TypeScript accepts any string, and no snapshot covers a
 * canvas Monaco paints itself.
 */
import { describe, expect, mock, test } from "bun:test";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";

type DefinedTheme = [string, { base: string; inherit: boolean; rules: unknown[]; colors: Record<string, string> }];

/** A Monaco stand-in that records every `editor.defineTheme` call instead of painting. */
function createRecordingMonaco() {
  const defineTheme = mock((_id: string, _theme: unknown) => {});
  const instance = { editor: { defineTheme } } as never;
  return {
    instance,
    calls: () => defineTheme.mock.calls as unknown as DefinedTheme[],
  };
}

/**
 * Reads one recorded definition by its id rather than by position, and THROWS BY NAME when
 * the recorder holds nothing: a test that destructures `calls[0]` of an empty array reports a
 * TypeError about `undefined`, which reads like a broken test rather than an undefined theme.
 */
function definitionOf(calls: DefinedTheme[], id: string): DefinedTheme[1] {
  if (calls.length === 0) {
    throw new Error(`defineStudioThemes defined no theme at all, so "${id}" is missing`);
  }
  const found = calls.find(([definedId]) => definedId === id);
  if (!found) {
    throw new Error(`defineStudioThemes never defined "${id}"; it defined ${calls.map(([n]) => n).join(", ")}`);
  }
  return found[1];
}

const DARK_THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "569cd6", fontStyle: "bold" },
    { token: "function", foreground: "dcdcaa" },
    { token: "string", foreground: "ce9178" },
    { token: "number", foreground: "b5cea8" },
    { token: "comment", foreground: "6a9955" },
    { token: "operator", foreground: "d4d4d4" },
    { token: "identifier", foreground: "9cdcfe" },
  ],
  colors: {
    "editor.background": "#050505",
    "editor.foreground": "#d4d4d4",
    "editorCursor.foreground": "#569cd6",
    "editor.lineHighlightBackground": "#111111",
    "editorLineNumber.foreground": "#333333",
    "editorLineNumber.activeForeground": "#666666",
    "editor.selectionBackground": "#264f78",
    "editor.inactiveSelectionBackground": "#3a3d41",
    "editorIndentGuide.background": "#1a1a1a",
    "editorIndentGuide.activeBackground": "#333333",
  },
};

const LIGHT_THEME = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "0000ff", fontStyle: "bold" },
    { token: "function", foreground: "795e26" },
    { token: "string", foreground: "a31515" },
    { token: "number", foreground: "098658" },
    { token: "comment", foreground: "008000" },
    { token: "operator", foreground: "3f3f46" },
    { token: "identifier", foreground: "001080" },
  ],
  colors: {
    "editor.background": "#f4f4f5",
    "editor.foreground": "#27272a",
    "editorCursor.foreground": "#0000ff",
    "editor.lineHighlightBackground": "#e4e4e7",
    "editorLineNumber.foreground": "#a1a1aa",
    "editorLineNumber.activeForeground": "#52525b",
    "editor.selectionBackground": "#add6ff",
    "editor.inactiveSelectionBackground": "#e5ebf1",
    "editorIndentGuide.background": "#e4e4e7",
    "editorIndentGuide.activeBackground": "#a1a1aa",
  },
};

describe("the studio theme ids", () => {
  test("are the ids the query editor already shipped, so a hoist does not rename a theme", () => {
    expect(STUDIO_THEME_DARK).toBe("db-dark");
    expect(STUDIO_THEME_LIGHT).toBe("db-light");
  });
});

describe("defineStudioThemes", () => {
  test("defines both themes on the instance it is given, dark first, and defines nothing else", () => {
    const monaco = createRecordingMonaco();

    defineStudioThemes(monaco.instance);

    expect(monaco.calls().map(([id]) => id)).toEqual([STUDIO_THEME_DARK, STUDIO_THEME_LIGHT]);
  });

  test("defines the dark theme with the payload the query editor shipped, byte for byte", () => {
    const monaco = createRecordingMonaco();

    defineStudioThemes(monaco.instance);

    expect(definitionOf(monaco.calls(), STUDIO_THEME_DARK)).toEqual(DARK_THEME);
  });

  test("defines the light theme with the payload the query editor shipped, byte for byte", () => {
    const monaco = createRecordingMonaco();

    defineStudioThemes(monaco.instance);

    expect(definitionOf(monaco.calls(), STUDIO_THEME_LIGHT)).toEqual(LIGHT_THEME);
  });

  test("gives a second mount the same two definitions, which is the whole reason it exists", () => {
    const queryEditorMount = createRecordingMonaco();
    const sourceViewerMount = createRecordingMonaco();

    defineStudioThemes(queryEditorMount.instance);
    defineStudioThemes(sourceViewerMount.instance);

    expect(sourceViewerMount.calls().length).toBe(2);
    expect(sourceViewerMount.calls()).toEqual(queryEditorMount.calls());
  });
});
