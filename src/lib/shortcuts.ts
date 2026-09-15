import { SHORTCUTS, shortcutLabel } from "@/lib/keyboard-shortcuts";

export interface ShortcutEntry {
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  heading: string;
  shortcuts: ShortcutEntry[];
}

/**
 * The one place that answers "what shortcuts exist" (#746).
 *
 * `SHORTCUTS`/`shortcutLabel` from `@/lib/keyboard-shortcuts` cover every binding that also
 * feeds a Monaco keybinding or a `matchesShortcut` check — importing their labels here rather
 * than retyping them is what keeps this list from drifting the way `docs/FEATURES.md` no
 * longer can (`bun run shortcuts:sync` covers that file, not this one, hence this import).
 *
 * The rows below that are NOT drawn from `SHORTCUTS` (`?` itself, tab-strip arrow navigation,
 * the data profiler's Escape) are display-only: none of them is a Monaco command, so folding
 * them into a registry whose whole shape exists to feed `monacoKeybinding` would either force
 * a synthetic key code onto something that will never be one, or weaken the registry's typing
 * for every real entry to accommodate them. `?` in particular must stay outside it structurally,
 * not just by convention — it is a document-level listener that has to EXCLUDE the editor
 * (`?` is a live SQL placeholder character), the opposite of what belongs in a table Monaco
 * reads bindings from.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    heading: "General",
    shortcuts: [
      { keys: shortcutLabel(SHORTCUTS.commandPalette), description: "Open the command palette" },
      { keys: "?", description: "Show this shortcuts dialog" },
    ],
  },
  {
    heading: "Query editor",
    shortcuts: [
      { keys: shortcutLabel(SHORTCUTS.executeQuery), description: "Run the current query" },
      { keys: shortcutLabel(SHORTCUTS.formatQuery), description: "Format the query" },
    ],
  },
  {
    heading: "Tabs",
    shortcuts: [
      { keys: shortcutLabel(SHORTCUTS.newTab), description: "Open a new query tab" },
      { keys: "Left / Right arrow", description: "Move focus between tabs" },
      { keys: "Home / End", description: "Jump to the first / last tab" },
    ],
  },
  {
    heading: "Data profiler",
    shortcuts: [{ keys: "Escape", description: "Close the data profiler" }],
  },
];
