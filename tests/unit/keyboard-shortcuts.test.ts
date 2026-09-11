import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHORTCUTS, matchesShortcut, shortcutLabel, monacoKeybinding } from "@/lib/keyboard-shortcuts";
import { shortcutDocumentation, updateShortcutDocumentation } from "../../scripts/sync-shortcuts.mjs";

describe("shared keyboard shortcuts", () => {
  test("matches physical keys, including shifted and non-Latin characters", () => {
    for (const key of ["X", "ч"]) {
      for (const modifier of ["ctrlKey", "metaKey"]) {
        const event = new KeyboardEvent("keydown", { key, code: "KeyX", shiftKey: true, [modifier]: true });
        expect(matchesShortcut(event, SHORTCUTS.newTab)).toBe(true);
      }
    }
  });

  test("does not confuse missing modifiers, extra modifiers or a different physical key", () => {
    for (const change of [{ ctrlKey: false }, { shiftKey: false }, { altKey: true }, { code: "KeyY" }, { code: "" }]) {
      const event = new KeyboardEvent("keydown", { code: "KeyX", ctrlKey: true, shiftKey: true, ...change });
      expect(matchesShortcut(event, SHORTCUTS.newTab)).toBe(false);
    }
    expect(
      matchesShortcut(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true }), SHORTCUTS.commandPalette),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true, shiftKey: true }),
        SHORTCUTS.commandPalette,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(new KeyboardEvent("keydown", { code: "KeyB", metaKey: true }), SHORTCUTS.toggleSidebar),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { code: "KeyF", altKey: true, shiftKey: true }),
        SHORTCUTS.formatQuery,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { code: "KeyF", altKey: true, shiftKey: true, ctrlKey: true }),
        SHORTCUTS.formatQuery,
      ),
    ).toBe(false);
  });

  test("labels and Monaco bindings describe the same registered chords", () => {
    const monaco = {
      KeyMod: { CtrlCmd: 2048, Alt: 512, Shift: 1024 },
      KeyCode: { Enter: 3, KeyF: 36, KeyK: 41, KeyX: 54, KeyB: 32 },
    };
    expect(shortcutLabel(SHORTCUTS.executeQuery)).toBe("Cmd/Ctrl+Enter");
    expect(shortcutLabel(SHORTCUTS.formatQuery)).toBe("Alt+Shift+F");
    expect(shortcutLabel(SHORTCUTS.newTab)).toBe("Cmd/Ctrl+Shift+X");
    expect(monacoKeybinding(SHORTCUTS.executeQuery, monaco)).toBe(2051);
    expect(monacoKeybinding(SHORTCUTS.formatQuery, monaco)).toBe(1572);
    expect(monacoKeybinding(SHORTCUTS.commandPalette, monaco)).toBe(2089);
  });

  test("FEATURES shortcut list cannot drift from the registry", () => {
    const docs = readFileSync(new URL("../../docs/FEATURES.md", import.meta.url), "utf8");
    expect(docs).toContain(shortcutDocumentation());
  });

  test("regeneration replaces stale shortcuts, preserves surrounding prose and is idempotent", () => {
    for (const newline of ["\n", "\r\n"]) {
      const before = ["# Features", "*   **Keyboard Shortcuts:** stale", "Other features", ""].join(newline);
      const after = updateShortcutDocumentation(before);
      expect(after).toBe(["# Features", shortcutDocumentation(), "Other features", ""].join(newline));
      expect(updateShortcutDocumentation(after)).toBe(after);
    }
    expect(() => updateShortcutDocumentation("# Features\n")).toThrow("shortcut list is missing");
  });
});
