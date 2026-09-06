import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  composite,
  contrast,
  deltaEOk,
  parseColor,
  tailwindPalette,
  tailwindStep,
  toHex,
} from "../helpers/contrast";

/**
 * #402: the accents kept dark-tuned values on light grounds.
 *
 * #384 moved every NEUTRAL colour behind a token and left accents out of scope, so
 * `bg-blue-500/15 text-blue-300` — a chip you can read on `#0a0a0a` at 9.5:1 — went
 * on rendering over `#fafafa`, where the same two class names measure 1.46:1. The
 * pair was never a colour choice; it was a question whose answer depends on what is
 * behind it, and only one of the two answers had ever been looked at.
 *
 * This file is the answer being looked at, every run. It is deliberately NOT a
 * snapshot of the values: it recomputes the ratios from the tokens as declared and
 * from the Tailwind palette as installed, so it fails when either moves.
 *
 * Three separate contracts, and they fail for different reasons:
 *
 *   1. LEGIBILITY — every accent that carries text clears WCAG AA (4.5:1) on every
 *      ground it can land on, in BOTH palettes. This is the acceptance criterion.
 *   2. NO-OP IN DARK — the dark value of each token is exactly the Tailwind step the
 *      components carried before the migration. #384's rule, and the one #384 itself
 *      broke once (the editor scrollbar). Resolved from `node_modules`, not
 *      transcribed, so a Tailwind upgrade that restyles `blue-400` reports itself as
 *      what it is: a dark-mode change.
 *   3. SEPARATION — the identity hues encode WHICH THING, not what state, so they
 *      have to stay tellable apart. Selected per mode like `charts/palette.ts`, and
 *      held to the shipped dark set's own minimum rather than to a number invented
 *      here.
 */

const ROOT = join(import.meta.dir, "..", "..");
const theme = readFileSync(join(ROOT, "src", "styles", "theme.css"), "utf8");
const palette = tailwindPalette(ROOT);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): Map<string, string> {
  const css = stripComments(theme);
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return new Map(
    Array.from(css.slice(start, end).matchAll(/(--studio-[a-z0-9-]+)\s*:\s*([^;]+);/g), (m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}

const light = declarations(":root");
const dark = declarations(".dark");

const value = (palette: Map<string, string>, token: string): string => {
  const declared = palette.get(token);
  if (!declared) throw new Error(`theme.css declares no ${token}`);
  return declared;
};

const rgb = (palettes: Map<string, string>, token: string) => parseColor(value(palettes, token)).rgb;

/**
 * The grounds a coloured word can actually land on.
 *
 * Not a cartesian product of every colour against every other: measured that way,
 * the SHIPPED dark values fail, which would make the bar wrong rather than the
 * palette. This is the population as it exists in `src` — the five studio grounds,
 * a wash of the token's own hue (the #402 failure class), and the accent tile, the
 * one cross-hue ground that provably carries every identity hue at once (the
 * selected-engine tile in `ConnectionModal`, `bg-blue-600/10`).
 *
 * `/20` is the ceiling because no tint heavier than that carries coloured text
 * anywhere in `src`; `bg-blue-500/30` and `/50` exist, but as fills, never as a
 * ground under a word.
 */
const GROUNDS = {
  light: ["--studio-canvas", "--studio-sunken", "--studio-surface", "--studio-raised", "--studio-overlay"],
  dark: ["--studio-canvas", "--studio-sunken", "--studio-surface", "--studio-raised", "--studio-overlay"],
} as const;
const TINT_ALPHAS = [0.05, 0.1, 0.15, 0.2];
const ACCENT_TILE: ReadonlyArray<readonly [string, number]> = [
  ["--studio-accent-tint", 0.05],
  ["--studio-accent-tint", 0.1],
  ["--studio-accent-solid", 0.1],
];

const AA = 4.5;

/** The worst ratio `token` reaches anywhere it is allowed to be painted. */
function worstGround(
  palettes: Map<string, string>,
  token: string,
  ownTint: string,
): { ratio: number; where: string } {
  const foreground = rgb(palettes, token);
  let ratio = Number.POSITIVE_INFINITY;
  let where = "";
  const record = (candidate: number, label: string) => {
    if (candidate < ratio) {
      ratio = candidate;
      where = label;
    }
  };

  for (const groundToken of GROUNDS.light) {
    const ground = rgb(palettes, groundToken);
    record(contrast(foreground, ground), groundToken);
    for (const alpha of TINT_ALPHAS) {
      record(
        contrast(foreground, composite(rgb(palettes, ownTint), ground, alpha)),
        `${groundToken} + ${ownTint}/${alpha * 100}`,
      );
    }
    for (const [tile, alpha] of ACCENT_TILE) {
      record(
        contrast(foreground, composite(rgb(palettes, tile), ground, alpha)),
        `${groundToken} + ${tile}/${alpha * 100}`,
      );
    }
  }
  return { ratio, where };
}

/**
 * The contract, one row per token: which Tailwind step each palette reproduces, and
 * which tint the token is washed over when it sits on its own colour.
 *
 * The dark column is the whole of "dark does not move" — every one of these is the
 * literal a component carried before this migration.
 */
const TEXT_TOKENS: ReadonlyArray<{ token: string; light: string; dark: string; tint: string }> = [
  { token: "--studio-accent", light: "blue-700", dark: "blue-400", tint: "--studio-accent-tint" },
  { token: "--studio-accent-bright", light: "blue-800", dark: "blue-300", tint: "--studio-accent-tint" },
  { token: "--studio-warning", light: "amber-800", dark: "amber-400", tint: "--studio-warning-tint" },
  { token: "--studio-warning-bright", light: "amber-900", dark: "amber-300", tint: "--studio-warning-tint" },
  { token: "--studio-success", light: "emerald-800", dark: "emerald-400", tint: "--studio-success-tint" },
  { token: "--studio-success-bright", light: "emerald-900", dark: "emerald-300", tint: "--studio-success-tint" },
  { token: "--studio-danger", light: "red-800", dark: "red-400", tint: "--studio-danger-tint" },
  { token: "--studio-danger-bright", light: "red-900", dark: "red-300", tint: "--studio-danger-tint" },
];

/**
 * The identity palette. `-alt` is a second step of the same hue: sometimes a second
 * IDENTITY (db-ui-config has more engines than there are hues, and its own test
 * asserts all of them differ), sometimes just emphasis on one.
 */
const HUES: ReadonlyArray<{ hue: string; light: string; lightAlt: string }> = [
  { hue: "blue", light: "blue-700", lightAlt: "blue-800" },
  { hue: "sky", light: "sky-800", lightAlt: "sky-900" },
  { hue: "indigo", light: "indigo-700", lightAlt: "indigo-800" },
  { hue: "violet", light: "violet-700", lightAlt: "violet-800" },
  { hue: "purple", light: "purple-700", lightAlt: "purple-800" },
  { hue: "pink", light: "pink-800", lightAlt: "pink-900" },
  { hue: "rose", light: "rose-800", lightAlt: "rose-900" },
  { hue: "red", light: "red-800", lightAlt: "red-900" },
  { hue: "orange", light: "orange-800", lightAlt: "orange-900" },
  { hue: "amber", light: "amber-900", lightAlt: "amber-950" },
  { hue: "yellow", light: "yellow-800", lightAlt: "yellow-950" },
  { hue: "green", light: "green-800", lightAlt: "green-900" },
  { hue: "emerald", light: "emerald-800", lightAlt: "emerald-900" },
  { hue: "teal", light: "teal-800", lightAlt: "teal-950" },
  { hue: "cyan", light: "cyan-800", lightAlt: "cyan-900" },
];

/**
 * The four hues where two engines share a hue and are held apart only by step, so
 * the `-alt` is a distinct IDENTITY and has to join the separation set. Pinned by
 * `tests/unit/lib/db-ui-config.test.ts`, which asserts every engine colour differs.
 */
const IDENTITY_ALTS = ["sky", "yellow", "emerald", "teal"] as const;

describe("accent text clears WCAG AA on every ground it can land on", () => {
  for (const { token, tint } of TEXT_TOKENS) {
    test(`${token} in light`, () => {
      const { ratio, where } = worstGround(light, token, tint);
      expect({ token, worst: `${ratio.toFixed(2)}:1`, where }).toEqual({
        token,
        worst: `${ratio.toFixed(2)}:1`,
        where,
      });
      expect(ratio).toBeGreaterThanOrEqual(AA);
    });

    test(`${token} in dark`, () => {
      expect(worstGround(dark, token, tint).ratio).toBeGreaterThanOrEqual(AA);
    });
  }

  for (const { hue } of HUES) {
    for (const suffix of ["", "-alt"]) {
      const token = `--studio-hue-${hue}${suffix}`;
      test(`${token} in both palettes`, () => {
        expect(worstGround(light, token, `--studio-hue-${hue}-tint`).ratio).toBeGreaterThanOrEqual(AA);
        expect(worstGround(dark, token, `--studio-hue-${hue}-tint`).ratio).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});

/**
 * The regression #402 is about, stated as itself rather than as a floor: the pairing
 * from the issue's own table. If someone reverts the accent to a -300/-400 step,
 * every "clears AA" test above fails too — but this one names the defect.
 */
describe("the pairing from the issue", () => {
  test("an accent word on an accent chip is readable in light, not just in dark", () => {
    for (const palettes of [light, dark]) {
      const chip = composite(rgb(palettes, "--studio-accent-tint"), rgb(palettes, "--studio-surface"), 0.15);
      expect(contrast(rgb(palettes, "--studio-accent-bright"), chip)).toBeGreaterThanOrEqual(AA);
    }
  });

  test("the value that failed is gone from the light palette", () => {
    // blue-300 over blue-500/15 over #fafafa measured 1.46:1. Not a floor test —
    // this asserts the specific value is no longer what light mode paints.
    expect(value(light, "--studio-accent-bright")).not.toBe(toHex(tailwindStep(palette, "blue-300")));
  });
});

describe("the dark palette reproduces the literals the components carried", () => {
  for (const { token, dark: step } of TEXT_TOKENS) {
    test(`${token} is still ${step}`, () => {
      expect(value(dark, token)).toBe(toHex(tailwindStep(palette, step)));
    });
  }

  for (const { hue } of HUES) {
    test(`--studio-hue-${hue} is still ${hue}-400, and its -alt still ${hue}-300`, () => {
      expect(value(dark, `--studio-hue-${hue}`)).toBe(toHex(tailwindStep(palette, `${hue}-400`)));
      expect(value(dark, `--studio-hue-${hue}-alt`)).toBe(toHex(tailwindStep(palette, `${hue}-300`)));
    });

    /**
     * A wash is the -500 step at some alpha in both palettes — the value the
     * components already carried as `bg-<hue>-500/10`. Transcribing thirty of these
     * by hand got `green-500` wrong by one digit on the first attempt; resolving
     * them is what caught it.
     */
    test(`--studio-hue-${hue}-tint is ${hue}-500 in both palettes`, () => {
      const step = toHex(tailwindStep(palette, `${hue}-500`));
      expect(value(dark, `--studio-hue-${hue}-tint`)).toBe(step);
      expect(value(light, `--studio-hue-${hue}-tint`)).toBe(step);
    });
  }

  /**
   * The tints and the solid grounds are the same value in both palettes on purpose:
   * a wash is alpha over whatever is behind it, so it already adapts, and a filled
   * button's label contrast does not depend on the page. Declaring them twice is
   * what the palette-parity test requires; declaring them DIFFERENTLY would be a
   * silent dark-mode change.
   */
  for (const role of ["accent", "warning", "success", "danger"]) {
    for (const suffix of ["tint", "solid", "solid-hover"]) {
      test(`--studio-${role}-${suffix} is mode-independent`, () => {
        expect(value(light, `--studio-${role}-${suffix}`)).toBe(value(dark, `--studio-${role}-${suffix}`));
      });
    }
  }
});

describe("the light values are the ones that were selected", () => {
  for (const { token, light: step } of TEXT_TOKENS) {
    test(`${token} is ${step}`, () => {
      expect(value(light, token)).toBe(toHex(tailwindStep(palette, step)));
    });
  }

  for (const { hue, light: step, lightAlt } of HUES) {
    test(`--studio-hue-${hue} is ${step}, its -alt ${lightAlt}`, () => {
      expect(value(light, `--studio-hue-${hue}`)).toBe(toHex(tailwindStep(palette, step)));
      expect(value(light, `--studio-hue-${hue}-alt`)).toBe(toHex(tailwindStep(palette, lightAlt)));
    });
  }
});

describe("the identity hues stay tellable apart", () => {
  const closestPair = (palettes: Map<string, string>, tokens: string[]) => {
    let closest = Number.POSITIVE_INFINITY;
    let pair = "";
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const distance = deltaEOk(rgb(palettes, tokens[i]), rgb(palettes, tokens[j]));
        if (distance < closest) {
          closest = distance;
          pair = `${tokens[i]} vs ${tokens[j]}`;
        }
      }
    }
    return { closest, pair };
  };

  const identitySet = HUES.map(({ hue }) => `--studio-hue-${hue}`).concat(
    IDENTITY_ALTS.map((hue) => `--studio-hue-${hue}-alt`),
  );

  /**
   * The bar is the SHIPPED dark set's own minimum, not a number chosen here. Dark is
   * what users look at today and nobody has called it muddy, so a light set that is
   * no tighter anywhere is a light set that is at least as legible — and the claim
   * survives someone later retuning dark, because the bar moves with it.
   */
  test("the light set is no tighter than the dark set it is modelled on", () => {
    const darkest = closestPair(dark, identitySet);
    const lightest = closestPair(light, identitySet);
    expect({
      bar: darkest.closest.toFixed(4),
      barPair: darkest.pair,
      light: lightest.closest.toFixed(4),
      lightPair: lightest.pair,
    }).toEqual({
      bar: darkest.closest.toFixed(4),
      barPair: darkest.pair,
      light: lightest.closest.toFixed(4),
      lightPair: lightest.pair,
    });
    expect(lightest.closest).toBeGreaterThanOrEqual(darkest.closest);
  });

  /**
   * `-alt` exists to be a DIFFERENT colour from its base — two engines, or an icon
   * beside the value it labels. A pair that collapses defeats the reason the token
   * was added, and does it invisibly: both still clear AA.
   */
  test("every -alt is distinguishable from its own base, in both palettes", () => {
    for (const { hue } of HUES) {
      for (const palettes of [light, dark]) {
        expect(deltaEOk(rgb(palettes, `--studio-hue-${hue}`), rgb(palettes, `--studio-hue-${hue}-alt`))).toBeGreaterThan(
          0.05,
        );
      }
    }
  });

  /**
   * The emphasis steps have the same job inside the state roles. In dark `-bright`
   * is literally brighter; in light it is darker — the same inversion `fg-bright`
   * already makes, and the reason the token is not called `-light`.
   */
  test("every state -bright is distinguishable from its own base, in both palettes", () => {
    for (const role of ["accent", "warning", "success", "danger"]) {
      for (const palettes of [light, dark]) {
        expect(deltaEOk(rgb(palettes, `--studio-${role}`), rgb(palettes, `--studio-${role}-bright`))).toBeGreaterThan(
          0.05,
        );
      }
    }
  });
});
