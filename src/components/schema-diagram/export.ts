import { getViewportForBounds, type Rect, type Viewport } from "@xyflow/react";
import { downloadBlob } from "@/lib/export/download";

// Browser canvas hard limits (Chrome/Safari, canvas-size test data): a canvas
// over 16384px per side or ~268M pixels of area draws NOTHING - the failure
// is silent, so the capture scale must be capped up front rather than caught.
export const MAX_CANVAS_SIDE = 16_384;
export const MAX_CANVAS_AREA = 268_435_456;

/**
 * The ground painted behind an exported diagram, per theme.
 *
 * An exported file has no page under it, so the capture has to carry its own
 * ground — and it has to be the ground of the theme the diagram was drawn in.
 * Left pinned dark, a light-mode export came out as white table cards with dark
 * text on a near-black field. Same reasoning as the charts' `exportBackground`;
 * these values match `--studio-canvas`, which is what the diagram sits on.
 */
export const EXPORT_BACKGROUND = {
  dark: "#050505",
  light: "#f4f4f5",
} as const;
const EXPORT_PADDING = 32;
// Desired capture sharpness; capPixelRatio clamps it for huge diagrams.
const EXPORT_SCALE = 2;

export function capPixelRatio(width: number, height: number, desired: number): number {
  return Math.min(
    desired,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
}

/**
 * Decodes an SVG data URL (snapdom's capture) into a downloadable Blob.
 * snapdom only applies backgroundColor when rasterizing, so the canvas
 * background is injected here - without it the SVG renders on white.
 */
export function svgDataUrlToBlob(dataUrl: string, background: string = EXPORT_BACKGROUND.dark): Blob {
  const prefixMatch = /^data:image\/svg\+xml[^,]*,/.exec(dataUrl);
  if (!prefixMatch) {
    throw new Error("Not an SVG data URL");
  }
  const svg = decodeURIComponent(dataUrl.slice(prefixMatch[0].length));
  const withBackground = svg.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="${background}"/>`);
  return new Blob([withBackground], { type: "image/svg+xml;charset=utf-8" });
}

export interface ExportLayout {
  width: number;
  height: number;
  viewport: Viewport;
  transform: string;
}

/**
 * Full-diagram export layout: the logical image is the node bounds plus
 * padding at zoom <= 1 (never upscaled - sharpness comes from the capture
 * scale). The transform is applied to the live viewport for the duration of
 * the capture and restored afterwards.
 */
export function computeExportLayout(bounds: Rect, padding: number = EXPORT_PADDING): ExportLayout {
  const width = Math.max(1, Math.ceil(bounds.width + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.height + padding * 2));
  const viewport = getViewportForBounds(bounds, width, height, 0.01, 1, 0);
  return {
    width,
    height,
    viewport,
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
  };
}

export function buildExportFilename(format: "png" | "svg"): string {
  return `erd_${Date.now()}.${format}`;
}

export interface ExportViewportOptions {
  viewport: HTMLElement;
  bounds: Rect;
  /** Ground for the captured file. Defaults to dark, the theme studio starts in. */
  background?: string;
}

/**
 * Captures the React Flow viewport as PNG or SVG and triggers a download.
 * Throws on failure - the caller owns user feedback.
 *
 * snapdom is used instead of the html-to-image family: those clone every
 * computed style (including Tailwind 4's hundreds of custom properties) onto
 * every element, which balloons an 80-table diagram to hundreds of megabytes
 * of SVG and fails after ~90s. snapdom captures the same DOM in seconds.
 * Fonts are not embedded: webfont-embed CSS collection reads cssRules from
 * every stylesheet and Monaco's cross-origin CDN stylesheet makes that throw.
 */
export async function exportViewportImage(format: "png" | "svg", options: ExportViewportOptions): Promise<void> {
  const { viewport, bounds, background = EXPORT_BACKGROUND.dark } = options;
  const layout = computeExportLayout(bounds);
  const scale = capPixelRatio(layout.width, layout.height, EXPORT_SCALE);
  const { snapdom } = await import("@zumer/snapdom");

  // snapdom snapshots the live DOM, captures the target element's OWN box,
  // and normalizes away any translate() on that root element - so the
  // viewport (which carries the fit-all transform) must NOT be the capture
  // root. Instead its parent pane is resized to the export box and captured,
  // preserving the viewport child's transform. The caller covers the canvas
  // with an overlay meanwhile; all styles are restored even on throw.
  const pane = viewport.parentElement;
  if (!pane) {
    throw new Error("Diagram viewport is not attached to the document");
  }
  const saved = {
    transform: viewport.style.transform,
    width: pane.style.width,
    height: pane.style.height,
  };
  viewport.style.transform = layout.transform;
  pane.style.width = `${layout.width}px`;
  pane.style.height = `${layout.height}px`;
  let capture: { toBlob(opts: { type: "png" }): Promise<Blob | null>; url: string };
  try {
    capture = await snapdom(pane, {
      backgroundColor: background,
      scale,
      embedFonts: false,
    });
  } finally {
    viewport.style.transform = saved.transform;
    pane.style.width = saved.width;
    pane.style.height = saved.height;
  }

  if (format === "png") {
    const blob = await capture.toBlob({ type: "png" });
    if (!blob) {
      throw new Error("PNG encoding produced no data");
    }
    downloadBlob(blob, buildExportFilename("png"));
  } else {
    downloadBlob(svgDataUrlToBlob(capture.url, background), buildExportFilename("svg"));
  }
}
