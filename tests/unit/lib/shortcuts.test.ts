import { describe, test, expect } from "bun:test";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import { SHORTCUTS, shortcutLabel } from "@/lib/keyboard-shortcuts";

describe("SHORTCUT_GROUPS", () => {
  test("every group has a heading and at least one shortcut", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const group of SHORTCUT_GROUPS) {
      expect(group.heading.length).toBeGreaterThan(0);
      expect(group.shortcuts.length).toBeGreaterThan(0);
      for (const shortcut of group.shortcuts) {
        expect(shortcut.keys.length).toBeGreaterThan(0);
        expect(shortcut.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("the new-tab entry uses the label the shared registry actually binds, not a copy of it", () => {
    const tabsGroup = SHORTCUT_GROUPS.find((g) => g.heading === "Tabs");
    expect(tabsGroup).toBeDefined();
    const newTabShortcut = tabsGroup!.shortcuts.find((s) => s.description.includes("new query tab"));
    expect(newTabShortcut?.keys).toBe(shortcutLabel(SHORTCUTS.newTab));
  });

  test("the command-palette and query-editor entries use the shared registry's labels", () => {
    const generalGroup = SHORTCUT_GROUPS.find((g) => g.heading === "General");
    const paletteShortcut = generalGroup?.shortcuts.find((s) => s.description.includes("command palette"));
    expect(paletteShortcut?.keys).toBe(shortcutLabel(SHORTCUTS.commandPalette));

    const editorGroup = SHORTCUT_GROUPS.find((g) => g.heading === "Query editor");
    const runShortcut = editorGroup?.shortcuts.find((s) => s.description.includes("Run"));
    const formatShortcut = editorGroup?.shortcuts.find((s) => s.description.includes("Format"));
    expect(runShortcut?.keys).toBe(shortcutLabel(SHORTCUTS.executeQuery));
    expect(formatShortcut?.keys).toBe(shortcutLabel(SHORTCUTS.formatQuery));
  });

  test("the command palette shortcut and ? are both listed under General", () => {
    const generalGroup = SHORTCUT_GROUPS.find((g) => g.heading === "General");
    expect(generalGroup?.shortcuts.map((s) => s.keys)).toEqual(
      expect.arrayContaining([shortcutLabel(SHORTCUTS.commandPalette), "?"]),
    );
  });
});
