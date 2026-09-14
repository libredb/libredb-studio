import type * as Monaco from "monaco-editor";

/**
 * The two editor themes, with ONE definition each, shared by every Monaco mount in the app.
 *
 * They used to be defined inside `QueryEditor`'s `beforeMount`, which is per-mount state:
 * `beforeMount` runs for the mount that declares it and for no other, so a second mount that
 * does not run that exact callback gets Monaco's stock `vs`/`vs-dark` and sits visibly beside
 * a query editor it does not match. The read-only object source viewer (#789) is that second
 * mount, and Phase 3's diff preview would be a third. Both import this module and hand it
 * their own `monaco` instance.
 *
 * `editor.defineTheme` registers on the Monaco INSTANCE, not on the mount, and monaco-editor
 * 0.56.0 documents it as "Define a new theme or update an existing theme"
 * (`monaco-editor/esm/vs/editor/editor.api.d.ts:1124`), so calling this from every mount's
 * `beforeMount` rewrites the same two entries with the same payload rather than accumulating
 * per-mount state.
 */

/** Theme id applied whenever the effective app theme is anything but light. */
export const STUDIO_THEME_DARK = "db-dark";

/** Theme id applied when the effective app theme is light. */
export const STUDIO_THEME_LIGHT = "db-light";

/**
 * Registers `db-dark` and `db-light` on the Monaco instance handed in. Call it from a mount's
 * `beforeMount`, which is the last point before Monaco paints and the first at which an
 * instance exists.
 */
export function defineStudioThemes(monacoInstance: typeof Monaco): void {
  monacoInstance.editor.defineTheme(STUDIO_THEME_DARK, {
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
  });

  /*
   * Monaco paints its own canvas and knows nothing about the CSS token layer,
   * so the editor is the one surface that needs the palette written twice.
   * Same syntax hues either side, because they are chosen for contrast against the
   * CODE rather than against the chrome, with only the ground and the guides moved.
   * `editor.background` mirrors `--studio-canvas` in both themes so the pane
   * sits flush with the shell it lives in.
   */
  monacoInstance.editor.defineTheme(STUDIO_THEME_LIGHT, {
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
  });
}
