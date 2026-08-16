import { describe, expect, test } from "bun:test";

import { chartTheme, chartTooltipStyle } from "@/lib/charts/palette";

/**
 * These tests pin the palette's STRUCTURE, not its beauty. The colour checks that
 * actually matter — lightness band, chroma floor, CVD separation, normal-vision
 * separation, contrast — were run with the data-viz validator and their results
 * are recorded in the module's own doc comment; re-running an OKLab simulation
 * here would duplicate a tool rather than test this code.
 *
 * What CAN regress silently, and is therefore checked: that the two modes stay
 * two distinct selected sets rather than drifting into one shared array, and that
 * slot order never changes — series colour follows the entity, so a reordering
 * would repaint every saved chart's meaning.
 */
describe("chart palette", () => {
  const dark = chartTheme("dark");
  const light = chartTheme("light");

  test("both modes offer the same number of slots", () => {
    expect(dark.series).toHaveLength(8);
    expect(light.series).toHaveLength(8);
  });

  /**
   * The whole point of selecting rather than flipping: a shared array would mean
   * one ground got colours stepped for the other.
   */
  test("the dark set is stepped for dark — not the light set reused", () => {
    expect(dark.series).not.toEqual(light.series);

    // Green is the one hue that clears both grounds at the same step, so it is
    // the single slot allowed to match. Everything else moving in lockstep would
    // mean somebody replaced selection with a shared array.
    const shared = dark.series.filter((hex, slot) => hex === light.series[slot]);
    expect(shared).toEqual(["#008300"]);
  });

  test("every slot is a full six-digit hex the SVG canvas can take verbatim", () => {
    for (const hex of [...dark.series, ...light.series]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("slot order is fixed — blue first in both modes", () => {
    expect(dark.series[0]).toBe("#3987e5");
    expect(light.series[0]).toBe("#2a78d6");
  });

  // ── The chrome that is not a series ────────────────────────────────────────

  test("grid, axis and export ground differ per mode", () => {
    expect(dark.grid).not.toBe(light.grid);
    expect(dark.axis).not.toBe(light.axis);
    expect(dark.ink).not.toBe(light.ink);
    expect(dark.exportBackground).not.toBe(light.exportBackground);
  });

  /**
   * A PNG has no page behind it. Exporting a light chart onto the dark ground
   * (or the reverse) is the failure this pins: the export ground must sit on the
   * same side as the theme it was captured in.
   */
  test("the export ground matches the mode it was captured in", () => {
    expect(dark.exportBackground).toBe("#080808");
    expect(light.exportBackground).toBe("#fafafa");
  });
});

/**
 * Recharts writes `contentStyle` straight onto the element, so a tooltip cannot
 * resolve a CSS token and has to be handed the palette. Three charts consume this
 * — admin overview, audit stats, monitoring metric — and each one that kept its
 * own copy stayed a black box on a white page until somebody noticed.
 */
describe("chart tooltip style", () => {
  test("the light card is not the dark one", () => {
    expect(chartTooltipStyle("light").backgroundColor).not.toBe(chartTooltipStyle("dark").backgroundColor);
    expect(chartTooltipStyle("light").color).not.toBe(chartTooltipStyle("dark").color);
  });

  test("dark keeps the surface the charts already had", () => {
    expect(chartTooltipStyle("dark").backgroundColor).toBe("#18181b");
    expect(chartTooltipStyle("dark").color).toBe("#a1a1aa");
  });

  test("light is a white card with ink on it", () => {
    expect(chartTooltipStyle("light").backgroundColor).toBe("#ffffff");
    expect(chartTooltipStyle("light").color).toBe("#3f3f46");
  });

  /** Call sites spread it to vary one detail; the rest must survive that. */
  test("spreading it leaves the palette intact", () => {
    const varied = { ...chartTooltipStyle("light"), fontSize: 11 };
    expect(varied.backgroundColor).toBe("#ffffff");
    expect(varied.fontSize).toBe(11);
  });
});
