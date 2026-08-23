import { asBytes, binaryPreview, binaryText } from "@/lib/export/binary";
import type { ValueRenderer } from "./types";

// Monospaced, because hex is read by position: a reader comparing two values, or
// counting to an offset, needs the digits to line up.
const BINARY_CLASS = "text-cyan-400/80 font-mono";

// `classifyValue` selects this renderer with the same `asBytes` check, so a
// non-binary value cannot arrive here; the fallback exists so the narrowing is
// honest rather than asserted.
const NO_BYTES = new Uint8Array(0);

export const binaryRenderer: ValueRenderer = {
  kind: "binary",
  renderCompact(value) {
    return { display: binaryPreview(asBytes(value) ?? NO_BYTES), className: BINARY_CLASS };
  },
  renderDetail(value) {
    // The whole value, not the cell's preview: the sheet is where a reader goes to
    // copy the bytes out, and it is the form the export writes.
    return { text: binaryText(asBytes(value) ?? NO_BYTES), className: BINARY_CLASS, preserveWhitespace: false };
  },
};
