/**
 * Colour arithmetic for the theme tests.
 *
 * Every contrast figure this repository has ever recorded — the chart palette's
 * header, the login showcase comment, `AgentRail`'s "3.98:1" — is PROSE. It was
 * measured once, by hand, in a browser, and written down. Prose does not fail when
 * somebody changes the value it describes, which is how a token tuned against a
 * near-black ground survived into a light theme at 1.46:1 (#402).
 *
 * So this is deliberately not a mock or a fixture: it is the measurement, run in
 * the test process, from the same numbers the browser paints from.
 *
 * Three things it has to get right, all of which are easy to get subtly wrong:
 *
 *  1. Tailwind v4 ships its palette as `oklch()`, not hex. The conversion has to
 *     go oklch → Oklab → LMS → linear sRGB → gamma-encoded sRGB, and the vivid
 *     steps land outside the sRGB gamut and are CLIPPED per channel — which is
 *     what browsers do, and what makes the result equal Tailwind's own published
 *     hexes. Skipping the clip silently shifts every ratio.
 *
 *  2. An opacity modifier (`bg-accent-tint/15`) is not a colour, it is a colour
 *     that has to be composited over whatever is behind it before it can be
 *     measured. `text-x on bg-y/15` is a question about the COMPOSITE, and it is
 *     the question #402 turned on: blue-300 over `blue-500/15` is 9.48:1 on the
 *     dark ground and 1.46:1 on the light one — same two class names.
 *
 *  3. WCAG relative luminance is defined on LINEAR sRGB, while CSS alpha
 *     compositing happens in the gamma-encoded space. Compositing in the wrong
 *     one moves the answer by enough to flip a pass/fail at the 4.5:1 boundary.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Rgb = readonly [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** sRGB transfer function, gamma-encoded → linear. */
const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** sRGB transfer function, linear → gamma-encoded. */
const toGamma = (channel: number) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

/**
 * Oklab → linear sRGB (Björn Ottosson's matrices). Kept separate from the oklch
 * entry point because the identity-palette separation check needs Oklab itself,
 * not a colour derived from it.
 */
function oklabToLinearSrgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB → Oklab, the inverse of the above. */
export function toOklab([r, g, b]: Rgb): Rgb {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 0.2429228246 * m - 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Perceptual distance between two colours. Plain Euclidean distance in Oklab —
 * which is what Oklab is FOR, and what "these two identity hues are still
 * distinguishable" has to be asked in. Asking it in sRGB would call
 * `#00c951` and `#00d492` far apart and `#1447e6` and `#193cb8` close.
 */
export function deltaEOk(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** oklch(L% C H) → gamma-encoded sRGB, clipped to gamut the way a browser clips. */
export function oklchToRgb(lightnessPercent: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const linear = oklabToLinearSrgb(
    lightnessPercent / 100,
    chroma * Math.cos(hue),
    chroma * Math.sin(hue),
  );
  return linear.map((channel) => toGamma(clamp01(channel))) as unknown as Rgb;
}

export const toHex = (rgb: Rgb): string =>
  `#${rgb.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;

/**
 * Parse the colour syntaxes the token layer actually writes: `#rgb`, `#rrggbb`,
 * `rgb(r g b / a)` and `oklch(L% C H)`. Returns the colour and its alpha
 * separately, because a token carrying its own alpha (`--studio-hairline`) has to
 * be composited before it can be measured, exactly like an opacity modifier.
 */
export function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const text = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((d) => d + d)
            .join("")
        : hex[1];
    const rgb = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255) as unknown as Rgb;
    return { rgb, alpha: 1 };
  }

  const rgbFn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/i.exec(text);
  if (rgbFn) {
    const rgb = [rgbFn[1], rgbFn[2], rgbFn[3]].map((n) => Number(n) / 255) as unknown as Rgb;
    return { rgb, alpha: parseAlpha(rgbFn[4]) };
  }

  // `none` is a real oklch component value, and Tailwind writes it for the
  // achromatic steps (`oklch(98.5% 0 none)` — white has no hue). CSS resolves it
  // to zero in a plain colour, so parsing it as anything else drops the step.
  const oklch = /^oklch\(\s*([\d.]+)%\s+([\d.]+|none)\s+([\d.]+|none)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(text);
  if (oklch) {
    const component = (raw: string) => (raw.toLowerCase() === "none" ? 0 : Number(raw));
    return {
      rgb: oklchToRgb(Number(oklch[1]), component(oklch[2]), component(oklch[3])),
      alpha: parseAlpha(oklch[4]),
    };
  }

  throw new Error(`contrast: cannot parse colour ${JSON.stringify(value)}`);
}

const parseAlpha = (raw: string | undefined): number => {
  if (raw === undefined) return 1;
  return raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
};

/**
 * Lay `foreground` at `alpha` over `background`, source-over, in the
 * gamma-encoded space the browser composites in. A tint is only a colour once
 * this has happened; before that it is a question with two answers, one per
 * theme, which is the whole of #402.
 */
export function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map((channel, i) => channel * alpha + background[i] * (1 - alpha)) as unknown as Rgb;
}

/** WCAG 2.1 relative luminance — defined on linear sRGB, not on the hex digits. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio. Order-independent by construction. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The installed Tailwind palette, read from the package rather than transcribed.
 *
 * Transcribing it would make the "dark is a no-op" assertion a statement about a
 * number somebody typed in 2026, not about what the components render. A Tailwind
 * upgrade that restyles `blue-400` IS a dark-mode change, and this is what makes
 * the suite say so instead of staying green.
 */
export function tailwindPalette(root: string): Map<string, Rgb> {
  const css = readFileSync(join(root, "node_modules", "tailwindcss", "theme.css"), "utf8");
  const palette = new Map<string, Rgb>();
  for (const [, name, body] of css.matchAll(/--color-([a-z]+-\d{2,3}):\s*(oklch\([^)]*\));/g)) {
    palette.set(name, parseColor(body).rgb);
  }
  if (palette.size < 100) {
    throw new Error(`contrast: only ${palette.size} Tailwind colours parsed — the theme.css format moved`);
  }
  return palette;
}

/** `blue-400` → its sRGB value, or a loud failure naming the step. */
export function tailwindStep(palette: Map<string, Rgb>, step: string): Rgb {
  const rgb = palette.get(step);
  if (!rgb) throw new Error(`contrast: Tailwind has no colour named ${step}`);
  return rgb;
}
