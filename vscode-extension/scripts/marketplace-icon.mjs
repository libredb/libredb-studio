// The Marketplace icon (part 5, "Directory layout"), rendered at build time from the brand mark public/logo.svg through
// the root's sharp. The output media/icon.png is a build artifact: git ignores it and every build writes it again, as
// it does media/engines/**.

import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

/** The Marketplace icon's side in pixels: part 5 "Directory layout". */
export const ICON_SIZE = 128;
/** The brand source, relative to vscode-extension/. */
export const ICON_SOURCE = "../public/logo.svg";
/** The output, relative to vscode-extension/: the path the manifest's icon field names. */
export const ICON_OUTPUT = "media/icon.png";

/** The density the SVG is rasterised at before the resize, so even a 72 dpi, 200 px source renders at 512 px or more. */
const DENSITY = 288;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Renders the SVG at `source` into an ICON_SIZE by ICON_SIZE PNG with an alpha channel at `output`, fitted with
 * `fit: "contain"` on a transparent background; throws when the source is missing or the result is not that size.
 * @param {string} source
 * @param {string} output
 */
export async function writeMarketplaceIcon(source, output) {
  const svg = readFileSync(source);
  const png = await sharp(svg, { density: DENSITY })
    .resize(ICON_SIZE, ICON_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();
  const { width, height } = pngSize(png);
  if (width !== ICON_SIZE || height !== ICON_SIZE) {
    throw new Error(`${source} rendered at ${width}x${height}, not ${ICON_SIZE}x${ICON_SIZE}.`);
  }
  writeFileSync(output, png);
}

/**
 * The width and height a PNG's IHDR chunk declares; throws for a buffer that is not a PNG.
 * @param {Buffer} buffer
 */
export function pngSize(buffer) {
  const isPng =
    buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString("latin1", 12, 16) === "IHDR";
  if (!isPng) throw new Error("The buffer is not a PNG: it lacks the PNG signature and an IHDR chunk.");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
