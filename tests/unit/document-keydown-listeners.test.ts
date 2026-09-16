/**
 * The global keydown listeners, derived from the source rather than quoted from a grep nobody runs.
 *
 * Three shipped docblocks now enumerate these: `src/components/Studio.tsx`,
 * `src/workspace/StudioWorkspace.tsx` and the D82 block in
 * `tests/components/studio/embedded-source.test.tsx`. Each one exists because an apply dialog
 * cannot refuse a listener registered on `document`, so what is registered there decides whether
 * the D82 window is closed. Each was written by running a grep and copying its answer.
 *
 * That is how the previous sentence became false: it said there were TWO document listeners for as
 * long as that was true, `DataProfiler` added a third, and nothing noticed until a reviewer ran the
 * grep again. A sixth registration, or a fifth that moves to `document`, would make all three
 * sentences false in the same silence.
 *
 * So the grep runs here. This asserts the SITES, not the count: a bare number tells the next reader
 * nothing about which file grew a listener, and a diff that swaps one registration for another
 * would keep a count green.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });

/** `<target>.addEventListener("keydown", …)`, with the target as written. */
const REGISTRATION = /(\w+)\s*\.addEventListener\(\s*"keydown"/g;

/** Repository-relative and POSIX-spelled, so the sites read the same on Windows as on Linux. */
const repoRelative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

const registrations = sourceFiles(SRC)
  .flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(REGISTRATION)].map((match) => ({
      file: repoRelative(file),
      target: match[1],
    })),
  )
  .sort((a, b) => a.file.localeCompare(b.file));

describe("every global keydown listener in src", () => {
  test("the registrations are the six this repository has enumerated", () => {
    expect(registrations).toEqual([
      // Escape (#879), bound only while the generator is open. It closes that modal and moves no
      // tab; a prevented Escape belongs to the dialog above it and is left alone.
      { file: "src/components/CodeGenerator.tsx", target: "document" },
      // Cmd/Ctrl+K. Its table rows move the active tab, so the standalone shell refuses them
      // while an object apply is in flight (D82). The embedded shell renders no palette.
      { file: "src/components/CommandPalette.tsx", target: "document" },
      // Escape, bound only while the profiler is open, and it closes the profiler. Moves no tab,
      // and it is the listener the two-listener sentence used to miss.
      { file: "src/components/DataProfiler.tsx", target: "document" },
      // `?` (#746), guarded against the editor and every text input. Opens a dialog of shortcut
      // labels and moves no tab. `DataProfiler.tsx` always mounts one while it is open, so this
      // site is live on both shells even though only `Studio.tsx` mounts it directly.
      { file: "src/components/ShortcutsDialog.tsx", target: "document" },
      // The new-tab shortcut (#745), on `document` deliberately so it works while Monaco owns
      // focus. Both shells refuse it while an object apply is in flight (D82).
      { file: "src/components/studio/StudioTabBar.tsx", target: "document" },
      // An unused shadcn primitive with no importer anywhere in `src` (P5), and on `window`.
      { file: "src/components/ui/sidebar.tsx", target: "window" },
    ]);
  });

  test("exactly five of them are on document, which is what the apply dialog cannot refuse", () => {
    expect(registrations.filter((one) => one.target === "document").map((one) => one.file)).toEqual([
      "src/components/CodeGenerator.tsx",
      "src/components/CommandPalette.tsx",
      "src/components/DataProfiler.tsx",
      "src/components/ShortcutsDialog.tsx",
      "src/components/studio/StudioTabBar.tsx",
    ]);
  });

  test("the pattern finds something, so neither assertion above can pass on an empty sweep", () => {
    // The control. A regex that stopped matching would make both lists empty, and an empty list
    // equals an empty expectation only if the expectation is also empty, which these are not -
    // but a future edit that relaxed them would have no guard without this.
    expect(registrations.length).toBeGreaterThan(0);
  });
});
