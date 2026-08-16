import type React from "react";
import type { EffectiveTheme } from "@/hooks/use-effective-theme";

/**
 * The chart palette — the one place a series colour is chosen.
 *
 * Recharts paints an SVG canvas from JS values, so unlike every other surface in
 * the studio it cannot read the CSS token layer. The palette therefore lives here,
 * as two explicitly selected sets.
 *
 * **The dark set is not the light set flipped.** Each is stepped for its own
 * ground and validated against it; an automatic lightening would drift hues out
 * of the mode's lightness band and collapse pairs under colour-vision deficiency.
 *
 * Both sets are the reference categorical theme, in fixed slot order, validated
 * with the data-viz palette validator against this app's own chart surfaces:
 *
 *   dark  (#0a0a0a) — lightness band PASS · chroma PASS · worst adjacent CVD
 *                     ΔE 8.4 (yellow↔aqua, protan) · normal-vision ΔE 19.3 · contrast PASS
 *   light (#fafafa) — lightness band PASS · chroma PASS · worst adjacent CVD
 *                     ΔE 9.1 (yellow↔aqua, protan) · normal-vision ΔE 19.6
 *                     · contrast WARN on aqua/yellow/magenta (2.07–2.7 : 1)
 *
 * That light-mode contrast warning is discharged, not ignored: every chart form
 * here ships a legend, and the rows behind it are always available as a table in
 * the Results panel — which is exactly the relief the rule asks for. Do not use
 * these values as TEXT colour; a 2.07:1 label is unreadable. Series colour belongs
 * on a mark, with the text beside it in the ink ramp.
 *
 * The palette this replaced was the Tailwind 500 row, which failed the same
 * validator on the dark surface: green↔amber came out at ΔE 5.7 under protan,
 * below the 8.0 target and inside the band that is only legal with secondary
 * encoding — two adjacent series a red-blind reader could not separate.
 */
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;

export interface ChartTheme {
  /** Categorical series colours, in fixed slot order. */
  series: readonly string[];
  /** Grid lines — recessive by design; they orient, they do not compete. */
  grid: string;
  /** Axis tick labels. */
  axis: string;
  /**
   * Ink for text drawn ON the canvas — slice labels, legend entries. Recharts
   * paints both in the series colour by default, which is exactly what the
   * "text never wears the series colour" rule forbids: at 2.07:1 the yellow slot
   * is a legible mark and an illegible word.
   */
  ink: string;
  /** Ground painted behind a rasterized PNG export, which has no page under it. */
  exportBackground: string;
}

const THEMES: Record<EffectiveTheme, ChartTheme> = {
  dark: {
    series: SERIES.dark,
    grid: "#222222",
    axis: "#666666",
    ink: "#d4d4d8",
    exportBackground: "#080808",
  },
  light: {
    series: SERIES.light,
    grid: "#e4e4e7",
    axis: "#52525b",
    ink: "#27272a",
    exportBackground: "#fafafa",
  },
};

export function chartTheme(mode: EffectiveTheme): ChartTheme {
  return THEMES[mode];
}

/**
 * Inline style for a stock recharts `<Tooltip contentStyle>`.
 *
 * Recharts writes this straight onto the element, so the tooltip is one of the
 * few surfaces that cannot resolve a CSS token and must be handed both palettes.
 * It lives here rather than beside each chart because there are three of them —
 * the admin overview, the audit stats and the monitoring metric — and each one
 * left to itself is a place the next theme fix has to be remembered.
 *
 * The light entry is chosen for its own ground: a white card at the same hairline
 * weight the rest of the light theme uses, with text a step darker than the dark
 * side's, because zinc-400 on white does not clear contrast.
 *
 * Spread it to vary a detail — `{ ...chartTooltipStyle(mode), fontSize: 11 }`.
 */
const TOOLTIP: Record<EffectiveTheme, React.CSSProperties> = {
  dark: {
    backgroundColor: "#18181b",
    border: "1px solid rgb(255 255 255 / 0.1)",
    borderRadius: "8px",
    fontSize: 12,
    color: "#a1a1aa",
  },
  light: {
    backgroundColor: "#ffffff",
    border: "1px solid rgb(9 9 11 / 0.14)",
    borderRadius: "8px",
    fontSize: 12,
    color: "#3f3f46",
  },
};

export function chartTooltipStyle(mode: EffectiveTheme): React.CSSProperties {
  return TOOLTIP[mode];
}
