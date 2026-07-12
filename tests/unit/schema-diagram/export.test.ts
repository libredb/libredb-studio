import { describe, expect, test } from "bun:test";

import {
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  buildExportFilename,
  capPixelRatio,
  computeExportLayout,
  svgDataUrlToBlob,
} from "@/components/schema-diagram/export";

describe("capPixelRatio", () => {
  test("keeps the desired ratio for small images", () => {
    expect(capPixelRatio(1000, 800, 2)).toBe(2);
  });

  test("caps by the max canvas side", () => {
    const ratio = capPixelRatio(10_000, 1_000, 2);
    expect(ratio).toBeCloseTo(MAX_CANVAS_SIDE / 10_000, 5);
    expect(10_000 * ratio).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
  });

  test("caps by the max canvas area for large square diagrams", () => {
    const ratio = capPixelRatio(20_000, 20_000, 2);
    expect(20_000 * ratio * 20_000 * ratio).toBeLessThanOrEqual(MAX_CANVAS_AREA + 1);
    expect(ratio).toBeLessThan(1);
  });

  test("never exceeds the desired ratio", () => {
    expect(capPixelRatio(100, 100, 3)).toBe(3);
    expect(capPixelRatio(100, 100, 1)).toBe(1);
  });
});

describe("svgDataUrlToBlob", () => {
  test("decodes an SVG data URL into an SVG blob", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>users</text></svg>';
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const blob = svgDataUrlToBlob(dataUrl);
    expect(blob.type).toContain("image/svg+xml");
    expect(await blob.text()).toContain("<text>users</text>");
  });

  test("injects the export background right after the opening svg tag", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>users</text></svg>';
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const text = await svgDataUrlToBlob(dataUrl).text();
    expect(text).toMatch(/^<svg[^>]*><rect width="100%" height="100%" fill="#050505"\/><text>/);
  });

  test("rejects non-SVG data URLs", () => {
    expect(() => svgDataUrlToBlob("data:image/png;base64,AAAA")).toThrow();
  });
});

describe("computeExportLayout", () => {
  test("adds padding around the node bounds at zoom 1", () => {
    const layout = computeExportLayout({ x: 0, y: 0, width: 2000, height: 1000 }, 40);
    expect(layout.width).toBe(2080);
    expect(layout.height).toBe(1080);
    expect(layout.viewport.zoom).toBe(1);
    expect(layout.transform).toContain("translate(");
    expect(layout.transform).toContain("scale(1)");
  });

  test("shifts negative-origin bounds into view", () => {
    const layout = computeExportLayout({ x: -500, y: -200, width: 1000, height: 400 }, 0);
    expect(layout.viewport.x).toBeCloseTo(500, 3);
    expect(layout.viewport.y).toBeCloseTo(200, 3);
  });

  test("never upscales beyond zoom 1", () => {
    const layout = computeExportLayout({ x: 0, y: 0, width: 50, height: 50 }, 10);
    expect(layout.viewport.zoom).toBeLessThanOrEqual(1);
  });
});

describe("buildExportFilename", () => {
  test("produces timestamped erd filenames", () => {
    expect(buildExportFilename("png")).toMatch(/^erd_\d+\.png$/);
    expect(buildExportFilename("svg")).toMatch(/^erd_\d+\.svg$/);
  });
});
