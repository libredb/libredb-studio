import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const theme = readFileSync(join(ROOT, "src", "styles", "theme.css"), "utf8");
const globals = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");

/** Prose in this file talks ABOUT tokens; only declarations may be counted. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside one top-level block, by selector. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

function declaredIn(selector: string): Set<string> {
  const body = block(stripComments(theme), selector);
  return new Set(Array.from(body.matchAll(/(--studio-[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

const light = declaredIn(":root");
const dark = declaredIn(".dark");

/**
 * A token missing from one palette does not fall back to the other — it resolves
 * to nothing, which is invalid at computed-value time. The failure is silent and
 * mode-specific: a ground drops to transparent, a hairline to `currentColor`, and
 * only in the theme nobody happened to be looking at. So the two palettes are
 * checked as sets, not spot-checked.
 */
describe("the two palettes cover the same tokens", () => {
  test("every light token has a dark value", () => {
    expect([...light].filter((token) => !dark.has(token))).toEqual([]);
  });

  test("every dark token has a light value", () => {
    expect([...dark].filter((token) => !light.has(token))).toEqual([]);
  });

  test("the palettes are not empty (the block parse actually found declarations)", () => {
    expect(light.size).toBeGreaterThan(15);
  });
});

describe("every token reference resolves to a declaration", () => {
  /**
   * `@theme inline` is what turns a token into a Tailwind utility. A mapping
   * pointing at a name no palette declares compiles fine and emits a utility that
   * colours nothing.
   */
  test("the @theme mapping points only at declared tokens", () => {
    const mapping = block(stripComments(theme), "@theme inline");
    const referenced = Array.from(mapping.matchAll(/var\((--studio-[a-z0-9-]+)\)/g), (m) => m[1]);
    expect(referenced.length).toBeGreaterThan(15);
    expect(referenced.filter((token) => !light.has(token))).toEqual([]);
  });

  /**
   * globals.css reaches for the tokens directly in the rules Tailwind cannot
   * express (`.glass-panel`, the editor scrollbar). Those references are just as
   * silent when they miss.
   */
  test("globals.css references only declared tokens", () => {
    const referenced = Array.from(stripComments(globals).matchAll(/var\((--studio-[a-z0-9-]+)\)/g), (m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((token) => !light.has(token))).toEqual([]);
  });

  test("globals.css imports the token layer, so standalone studio gets it too", () => {
    expect(globals).toContain('@import "../styles/theme.css"');
  });
});

/**
 * Tokenising a component was allowed to change how it looks in LIGHT — that was
 * the point — but never in dark, where the token values were chosen to reproduce
 * the literals the components already carried. These are the values that were
 * argued over one at a time; pinning them is what makes "no-op in dark" checkable
 * rather than a claim in a commit message.
 */
describe("the dark palette still reproduces the pre-token literals", () => {
  const value = (token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(block(stripComments(theme), ".dark"))?.[1];

  test("the surface ramp", () => {
    expect(value("--studio-canvas")).toBe("#050505");
    expect(value("--studio-surface")).toBe("#0a0a0a");
    expect(value("--studio-panel")).toBe("rgb(24 24 27 / 0.5)");
  });

  test("the hairlines", () => {
    expect(value("--studio-hairline")).toBe("rgb(255 255 255 / 0.05)");
    expect(value("--studio-hairline-strong")).toBe("rgb(255 255 255 / 0.1)");
  });

  test("the text ramp", () => {
    expect(value("--studio-fg")).toBe("#e4e4e7");
    expect(value("--studio-fg-muted")).toBe("#71717a");
  });

  /**
   * The one that regressed. Routed through the text ramp, the editor thumb went
   * #262626 → #52525b and its hover #404040 → #71717a — a chrome detail promoted
   * to the brightest thing on a quiet panel, in a PR whose contract was that dark
   * does not move.
   */
  test("the editor scrollbar", () => {
    expect(value("--studio-scrollbar")).toBe("#262626");
    expect(value("--studio-scrollbar-hover")).toBe("#404040");
  });
});
