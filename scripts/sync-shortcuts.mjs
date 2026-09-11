// Run with Bun so the documentation and application import the same TypeScript registry.
import { readFileSync, writeFileSync } from "node:fs";
import { SHORTCUTS, shortcutLabel } from "../src/lib/keyboard-shortcuts.ts";

export function shortcutDocumentation() {
  return `*   **Keyboard Shortcuts:** ${Object.values(SHORTCUTS)
    .map((shortcut) => `\`${shortcutLabel(shortcut)}\` to ${shortcut.description}`)
    .join(", ")}.`;
}

export function updateShortcutDocumentation(source) {
  const list = /^\*   \*\*Keyboard Shortcuts:\*\*[^\r\n]*/m;
  if (!list.test(source)) throw new Error("FEATURES.md shortcut list is missing");
  return source.replace(list, shortcutDocumentation());
}

if (import.meta.main) {
  const file = new URL("../docs/FEATURES.md", import.meta.url);
  const before = readFileSync(file, "utf8");
  const after = updateShortcutDocumentation(before);
  if (process.argv.includes("--check")) {
    if (before !== after) throw new Error("Shortcut documentation has drifted; run bun run shortcuts:sync");
  } else {
    writeFileSync(file, after);
  }
}
