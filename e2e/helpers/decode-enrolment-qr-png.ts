import jsQR from "jsqr";
import { PNG } from "pngjs";

/** Decodes a PNG screenshot of the enrolment QR in Node (real Chromium capture, not happy-dom). */
export function decodeEnrolmentQrPngBuffer(pngBytes: Buffer): string {
  const png = PNG.sync.read(pngBytes);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded?.data) throw new Error("Could not decode the enrolment QR PNG.");
  return decoded.data;
}
