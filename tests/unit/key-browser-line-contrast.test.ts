/**
 * Every line the Keys panel writes is measured against the ground it lands on, as a ratio.
 *
 * THIS FILE EXISTS BECAUSE A CLASS NAME IS NOT A COLOUR. The panel's completeness sentence (#1635) shipped in
 * `text-muted`, which resolves to `--muted`, a SURFACE token, `#f5f5f5` light and `#27272a` dark, one step
 * from the ground it sits on. The sentence that tells a reader the list may be incomplete was drawn in the
 * colour of the panel behind it: measured in a browser, 1.09:1 light and 1.34:1 dark, at 10px.
 *
 * Every test in the suite passed. The text was in the DOM, its words were right, and the component rendered.
 * Only a screenshot caught it, and a screenshot is not a gate. So the gate is here: the classes the panel
 * actually uses are read out of `KeyBrowser.tsx`, resolved through `globals.css` to hex, and each one's
 * contrast against both grounds is asserted. A surface token used as text fails on the number, whatever it
 * is called, and so does any future line that reaches for one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, parseColor } from "../helpers/contrast";

const ROOT = join(import.meta.dir, "..", "..");
const PANEL = readFileSync(join(ROOT, "src/components/key-browser/KeyBrowser.tsx"), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const GLOBALS = strip(readFileSync(join(ROOT, "src/app/globals.css"), "utf8"));
const THEME = strip(readFileSync(join(ROOT, "src/styles/theme.css"), "utf8"));

/** The `--token: value;` declarations of one block, from both stylesheets, merged. */
function tokens(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const css of [GLOBALS, THEME]) {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) continue;
    const end = css.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    for (const m of css.slice(start, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const LIGHT = tokens(":root");
const DARK = tokens(".dark");

/** The control that both blocks were really read: a ground and a text colour differ in both. */
test("both stylesheets yielded both palettes", () => {
  for (const palette of [LIGHT, DARK]) {
    expect(palette.get("--background")).toBeDefined();
    expect(palette.get("--muted-foreground")).toBeDefined();
    expect(palette.get("--studio-warning")).toBeDefined();
    expect(palette.get("--background")).not.toBe(palette.get("--muted-foreground"));
  }
});

const hex = (palette: Map<string, string>, token: string): string => {
  const value = palette.get(token);
  if (value === undefined) throw new Error(`no ${token} in this palette`);
  return value;
};

/** A Tailwind colour class resolves through one of two prefixes; the panel uses both. */
function tokenFor(palette: Map<string, string>, name: string): string {
  if (palette.has(`--${name}`)) return `--${name}`;
  if (palette.has(`--studio-${name}`)) return `--studio-${name}`;
  throw new Error(`text-${name} resolves to no token in globals.css or theme.css`);
}

const ratio = (palette: Map<string, string>, name: string): number =>
  contrast(parseColor(hex(palette, tokenFor(palette, name))).rgb, parseColor(hex(palette, "--background")).rgb);

/**
 * Every colour class the panel writes, read from its own source.
 *
 * Driven from the file rather than from a table here, so a line added tomorrow is measured tomorrow. The
 * non-colour utilities that share the `text-` prefix (sizes, alignment, wrapping) are named out, and the
 * list is asserted below, so a new utility silently skipped would fail rather than shrink the sweep.
 */
const NOT_COLOURS = new Set(["xs", "sm", "base", "lg", "xl", "left", "right", "center", "wrap", "nowrap", "balance"]);
const USED = [...new Set(Array.from(PANEL.matchAll(/\btext-([a-z0-9-]+)\b/g), (m) => m[1]!))]
  .filter((name) => !NOT_COLOURS.has(name))
  .sort();

describe("the Keys panel's text colours, measured as ratios", () => {
  test("the sweep covers every colour class the panel writes", () => {
    expect(USED).toEqual(["brand", "foreground", "hue-yellow", "muted-foreground", "warning"]);
  });

  /**
   * 3:1 is WCAG AA for large text and the floor this panel's smallest line can defend; these lines are
   * 10px, so it is a floor against the catastrophic case rather than a claim of comfortable reading. What
   * it rules out is exactly what shipped: a surface token used as text, which lands near 1:1.
   */
  for (const name of ["brand", "foreground", "hue-yellow", "muted-foreground", "warning"]) {
    test(`text-${name} is legible on both grounds`, () => {
      for (const [label, palette] of [
        ["light", LIGHT],
        ["dark", DARK],
      ] as const) {
        const measured = ratio(palette, name);
        if (measured < 3) throw new Error(`text-${name} is ${measured.toFixed(2)}:1 on the ${label} ground`);
        expect(measured).toBeGreaterThanOrEqual(3);
      }
    });
  }

  /**
   * The specific line, named, so a reader sees what this file is for. The completeness sentence is the one
   * line whose whole purpose is to be read: it says the tree above it may be short.
   */
  test("the completeness sentence does not use a surface token", () => {
    const at = PANEL.indexOf('data-testid="key-browser-read-outcome"');
    expect(at).toBeGreaterThan(-1);
    expect(PANEL.slice(at - 400, at)).toContain("text-muted-foreground");

    // `--muted` is a surface, one step from the ground, which is what made it unreadable as text.
    for (const palette of [LIGHT, DARK]) {
      const surface = contrast(parseColor(hex(palette, "--muted")).rgb, parseColor(hex(palette, "--background")).rgb);
      expect(surface).toBeLessThan(2);
    }
    expect(ratio(LIGHT, "muted-foreground")).toBeGreaterThan(3);
    expect(ratio(DARK, "muted-foreground")).toBeGreaterThan(3);
  });
});
