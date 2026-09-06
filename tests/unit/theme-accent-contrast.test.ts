import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  composite,
  contrast,
  deltaEOk,
  luminance,
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

/** Every component source, concatenated, for the scans that have to read the code. */
function sourceOfSrc(): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(entry) ? [path] : [];
    });
  return walk(join(ROOT, "src"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}
const palette = tailwindPalette(ROOT);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): Map<string, string> {
  const css = stripComments(theme);
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return new Map(
    Array.from(css.slice(start, end).matchAll(/(--studio-[a-z0-9-]+)\s*:\s*([^;]+);/g), (m) => [m[1], m[2].trim()]),
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
 * The alpha ladder runs to `/30`. An earlier draft stopped at `/20` on the claim
 * that nothing heavier carried text — which was wrong: `AgentRail` and
 * `ConsentCard` put `-bright` text on a `/25` hover wash, including the very pill
 * this issue is about. The ladder is now a round ceiling rather than a survey, so
 * it cannot go stale the next time a call site picks a heavier wash.
 */
// One list, not one per mode: the ground TOKENS are the same in both palettes —
// it is their values that differ, and `worstGround` reads those from whichever
// palette it is handed.
const GROUNDS = [
  "--studio-canvas",
  "--studio-sunken",
  "--studio-surface",
  "--studio-raised",
  "--studio-overlay",
] as const;
/**
 * Derived from `src`, not asserted about it.
 *
 * The first draft hard-coded a `/20` ceiling on the claim that nothing heavier
 * carried text. That was wrong — `AgentRail` and `ConsentCard` put `-bright` text
 * on a `/25` hover wash, including the very pill this issue is about — and it was
 * wrong in the way a comment is always wrong: silently, and only until someone
 * reads it. Scanning for the alphas that a wash is actually painted at means the
 * ladder cannot drift away from the code again.
 *
 * Alphas above `TEXT_CEILING` are fills — a progress bar, a pulsing dot, a resize
 * handle — never a ground under a word, and including them would force every token
 * two steps darker to satisfy a case that does not exist.
 */
const TEXT_CEILING = 0.25;
const TINT_ALPHAS = (() => {
  const src = sourceOfSrc();
  const found = new Set<number>();
  for (const [, alpha] of src.matchAll(
    /\bbg-(?:brand|warning|success|danger|hue-[a-z]+)(?:-tint|-solid)?\/(\d{1,3})\b/g,
  )) {
    const value = Number(alpha) / 100;
    if (value <= TEXT_CEILING) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
})();
const ACCENT_TILE: ReadonlyArray<readonly [string, number]> = [
  ["--studio-brand-tint", 0.05],
  ["--studio-brand-tint", 0.1],
  ["--studio-brand-solid", 0.1],
];

const AA = 4.5;

/** The worst ratio `token` reaches anywhere it is allowed to be painted. */
function worstGround(palettes: Map<string, string>, token: string, ownTint: string): { ratio: number; where: string } {
  const foreground = rgb(palettes, token);
  let ratio = Number.POSITIVE_INFINITY;
  let where = "";
  const record = (candidate: number, label: string) => {
    if (candidate < ratio) {
      ratio = candidate;
      where = label;
    }
  };

  for (const groundToken of GROUNDS) {
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
  { token: "--studio-brand", light: "blue-700", dark: "blue-400", tint: "--studio-brand-tint" },
  { token: "--studio-brand-bright", light: "blue-800", dark: "blue-300", tint: "--studio-brand-tint" },
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
  { hue: "orange", light: "orange-900", lightAlt: "orange-950" },
  { hue: "amber", light: "amber-800", lightAlt: "amber-900" },
  { hue: "yellow", light: "yellow-800", lightAlt: "yellow-900" },
  { hue: "green", light: "green-800", lightAlt: "green-900" },
  { hue: "emerald", light: "emerald-800", lightAlt: "emerald-900" },
  { hue: "teal", light: "teal-800", lightAlt: "teal-950" },
  { hue: "cyan", light: "cyan-800", lightAlt: "cyan-900" },
  { hue: "fuchsia", light: "fuchsia-800", lightAlt: "fuchsia-900" },
];

/**
 * The four hues where two engines share a hue and are held apart only by step, so
 * the `-alt` is a distinct IDENTITY and has to join the separation set. Pinned by
 * `tests/unit/lib/db-ui-config.test.ts`, which asserts every engine colour differs.
 */
const IDENTITY_ALTS = ["sky", "yellow", "emerald", "teal"] as const;

/**
 * What theme.css actually declares, and what each declaration is supposed to be.
 *
 * Driven from the file rather than from the table above, in both directions: a
 * token the table does not know about fails, and a token the table needs but the
 * file no longer has fails too. A table alone would go quietly stale the first time
 * an unused token was pruned — which is exactly what happened while writing this.
 */
const declaredHue = new Set([...light.keys()].filter((token) => token.startsWith("--studio-hue-")));
const declaredHueText = [...declaredHue].filter((token) => !token.endsWith("-tint") && !/-solid(-hover)?$/.test(token));

const expectedSteps = new Map<string, { light: string; dark: string }>();
for (const { hue, light: base, lightAlt } of HUES) {
  expectedSteps.set(`--studio-hue-${hue}`, { light: base, dark: `${hue}-400` });
  expectedSteps.set(`--studio-hue-${hue}-alt`, { light: lightAlt, dark: `${hue}-300` });
  expectedSteps.set(`--studio-hue-${hue}-tint`, { light: `${hue}-500`, dark: `${hue}-500` });
  expectedSteps.set(`--studio-hue-${hue}-solid`, { light: `${hue}-600`, dark: `${hue}-600` });
  expectedSteps.set(`--studio-hue-${hue}-solid-hover`, { light: `${hue}-500`, dark: `${hue}-500` });
}

describe("accent text clears WCAG AA on every ground it can land on", () => {
  /**
   * The ladder is scanned out of `src`, so an empty or truncated scan would make
   * every test below measure plain grounds only — passing loudly while checking
   * nothing that matters.
   */
  test("the alpha ladder was actually found in the source", () => {
    expect(TINT_ALPHAS).toContain(0.25);
    expect(TINT_ALPHAS.length).toBeGreaterThanOrEqual(4);
  });

  for (const { token, tint } of TEXT_TOKENS) {
    test(`${token} in light`, () => {
      const { ratio, where } = worstGround(light, token, tint);
      // The ground is in the assertion, not beside it: a bare numeric comparison
      // fails with "4.21 is not >= 4.5" and says nothing about WHERE.
      expect([token, where, ratio >= AA]).toEqual([token, where, true]);
    });

    test(`${token} in dark`, () => {
      expect(worstGround(dark, token, tint).ratio).toBeGreaterThanOrEqual(AA);
    });
  }

  for (const token of declaredHueText) {
    const hue = /--studio-hue-([a-z]+)/.exec(token)![1];
    test(`${token} in both palettes`, () => {
      // A hue with no wash of its own is only ever painted on a studio ground or
      // the accent tile; `worstGround` falls back to the accent tint for it.
      const ownTint = light.has(`--studio-hue-${hue}-tint`) ? `--studio-hue-${hue}-tint` : "--studio-brand-tint";
      expect(worstGround(light, token, ownTint).ratio).toBeGreaterThanOrEqual(AA);
      expect(worstGround(dark, token, ownTint).ratio).toBeGreaterThanOrEqual(AA);
    });
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
      const chip = composite(rgb(palettes, "--studio-brand-tint"), rgb(palettes, "--studio-surface"), 0.15);
      expect(contrast(rgb(palettes, "--studio-brand-bright"), chip)).toBeGreaterThanOrEqual(AA);
    }
  });

  test("the value that failed is gone from the light palette", () => {
    // blue-300 over blue-500/15 over #fafafa measured 1.46:1. Not a floor test —
    // this asserts the specific value is no longer what light mode paints.
    expect(value(light, "--studio-brand-bright")).not.toBe(toHex(tailwindStep(palette, "blue-300")));
  });
});

describe("the dark palette reproduces the literals the components carried", () => {
  for (const { token, dark: step } of TEXT_TOKENS) {
    test(`${token} is still ${step}`, () => {
      expect(value(dark, token)).toBe(toHex(tailwindStep(palette, step)));
    });
  }

  test("every declared identity hue is the step it claims, in both palettes", () => {
    const wrong = [...declaredHue].filter((token) => {
      const expected = expectedSteps.get(token);
      if (!expected) return true;
      return (
        value(light, token) !== toHex(tailwindStep(palette, expected.light)) ||
        value(dark, token) !== toHex(tailwindStep(palette, expected.dark))
      );
    });
    expect(wrong).toEqual([]);
  });

  /**
   * The reverse direction. Without it, deleting `--studio-hue-teal-alt` would leave
   * every remaining assertion green — the suite would simply stop checking the
   * token that keeps Elasticsearch from looking like Druid.
   */
  test("every hue the identity palette is built on is declared", () => {
    const missing = HUES.flatMap(({ hue }) => (light.has(`--studio-hue-${hue}`) ? [] : [hue]));
    expect(missing).toEqual([]);
    for (const hue of IDENTITY_ALTS) expect(light.has(`--studio-hue-${hue}-alt`)).toBe(true);
  });

  /**
   * A wash is the -500 step at some alpha in both palettes — the value the
   * components already carried as `bg-<hue>-500/10`. Transcribing thirty of these
   * by hand got `green-500` wrong by one digit on the first attempt; resolving them
   * against the installed palette is what caught it.
   */
  test("every declared hue wash is that hue's -500 step, in both palettes", () => {
    const tints = [...declaredHue].filter((token) => token.endsWith("-tint"));
    expect(tints.length).toBeGreaterThan(5);
    for (const token of tints) {
      const hue = /--studio-hue-([a-z]+)-tint/.exec(token)![1];
      const step = toHex(tailwindStep(palette, `${hue}-500`));
      expect(value(dark, token)).toBe(step);
      expect(value(light, token)).toBe(step);
    }
  });

  /**
   * The tints and the solid grounds are the same value in both palettes on purpose:
   * a wash is alpha over whatever is behind it, so it already adapts, and a filled
   * button's label contrast does not depend on the page. Declaring them twice is
   * what the palette-parity test requires; declaring them DIFFERENTLY would be a
   * silent dark-mode change.
   */
  for (const role of ["brand", "warning", "success", "danger"]) {
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

  test("the identity table covers every declared hue token", () => {
    const unaccounted = [...declaredHue].filter((token) => !expectedSteps.has(token));
    expect(unaccounted).toEqual([]);
  });
});

/**
 * The filled controls. These are excluded from the AA text sweep above — they are
 * GROUNDS, not text — so without this block nothing measures the one thing that
 * matters about them: whether their label survives.
 *
 * The migration got this wrong once. Three standalone error pages hovered DOWN the
 * ramp (`bg-blue-600 hover:bg-blue-700`) where the rest of the app hovers up, and
 * flattening them onto `-solid-hover` inverted the direction and took white from
 * 6.8:1 to 3.8:1. Every gate stayed green.
 */
describe("a filled control keeps its label", () => {
  const WHITE = parseColor("#ffffff").rgb;
  const label = (token: string) => contrast(rgb(light, token), WHITE);

  test("the two roles that carry a white label clear AA, resting and on hover", () => {
    for (const token of ["--studio-brand-solid", "--studio-brand-solid-active", "--studio-danger-solid"]) {
      expect([token, label(token) >= AA]).toEqual([token, true]);
    }
  });

  /**
   * `-solid-active` exists ONLY to be darker than the ground it hovers from. If it
   * ever stops being darker it is not merely wrong, it is pointless — and the three
   * pages that use it would silently go back to the regression above.
   */
  test("the active step is darker than the ground it hovers from", () => {
    expect(luminance(rgb(light, "--studio-brand-solid-active"))).toBeLessThan(
      luminance(rgb(light, "--studio-brand-solid")),
    );
  });

  /**
   * Deferred, deliberately, and pinned so the deferral is a fact rather than a
   * sentence. `warning`, `success` and the teal "AI Describe" button are filled at
   * their -600 step under a white label, which is around 3.2-3.7:1 — under AA, in
   * BOTH themes, and under AA before this migration too. Darkening them enough for
   * white is a visible change to a control this issue never claimed, so it is filed
   * separately; when it lands, this test fails and says so.
   *
   * Hover steps are excluded on purpose: every `-solid-hover` lightens, so none of
   * them clears AA against white, and that is the convention the app already had.
   * The resting state is what a label has to survive.
   */
  test("the roles whose white label is still under AA are exactly the two that already were", () => {
    const resting = [...light.keys()].filter((token) => /-solid$/.test(token));
    expect(resting.length).toBeGreaterThan(4);
    // Names, not ratios: a rounded number pinned here would fail on a rendering
    // change that moves nothing anyone can see.
    expect(resting.filter((token) => label(token) < AA)).toEqual([
      "--studio-warning-solid",
      "--studio-success-solid",
      "--studio-hue-teal-solid",
    ]);
  });
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

  test("the separation set is the whole identity palette (guard against a shrinking set)", () => {
    expect(identitySet.every((token) => light.has(token))).toBe(true);
    expect(identitySet.length).toBeGreaterThan(15);
  });

  /**
   * The bar is the SHIPPED dark set's own minimum, not a number chosen here. Dark is
   * what users look at today and nobody has called it muddy, so a light set that is
   * no tighter anywhere is a light set that is at least as legible — and the claim
   * survives someone later retuning dark, because the bar moves with it.
   */
  test("the light set is no tighter than the dark set it is modelled on", () => {
    const darkest = closestPair(dark, identitySet);
    const lightest = closestPair(light, identitySet);
    expect([lightest.pair, darkest.pair, lightest.closest >= darkest.closest]).toEqual([
      lightest.pair,
      darkest.pair,
      true,
    ]);
  });

  /**
   * `-alt` exists to be a DIFFERENT colour from its base — two engines, or an icon
   * beside the value it labels. A pair that collapses defeats the reason the token
   * was added, and does it invisibly: both still clear AA.
   */
  test("every -alt is distinguishable from its own base, in both palettes", () => {
    for (const token of [...declaredHue].filter((t) => t.endsWith("-alt"))) {
      const base = token.replace(/-alt$/, "");
      for (const palettes of [light, dark]) {
        expect(deltaEOk(rgb(palettes, base), rgb(palettes, token))).toBeGreaterThan(0.05);
      }
    }
  });

  /**
   * The emphasis steps have the same job inside the state roles. In dark `-bright`
   * is literally brighter; in light it is darker — the same inversion `fg-bright`
   * already makes, and the reason the token is not called `-light`.
   */
  test("every state -bright is distinguishable from its own base, in both palettes", () => {
    for (const role of ["brand", "warning", "success", "danger"]) {
      for (const palettes of [light, dark]) {
        expect(deltaEOk(rgb(palettes, `--studio-${role}`), rgb(palettes, `--studio-${role}-bright`))).toBeGreaterThan(
          0.05,
        );
      }
    }
  });
});
