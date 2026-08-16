import type { ValueRenderer } from "./types";

// Drops JSON's insignificant whitespace (space, tab, newline, CR) outside
// string literals, so a stored JSON text can be compared against the compact
// JSON.stringify of its parse to prove the round-trip lossless.
function stripJsonWhitespace(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      out += ch;
    }
  }
  return out;
}

export const jsonRenderer: ValueRenderer = {
  kind: "json",
  renderCompact(value) {
    // A JSON string keeps its raw single-line display in the grid; only the
    // detail sheet gives json-kind values the pretty treatment.
    if (typeof value === "string") {
      return { display: value, className: "text-fg-secondary" };
    }
    return { display: JSON.stringify(value), className: "text-blue-400/80 italic font-light" };
  },
  renderDetail(value) {
    // classifyValue only routes parseable container strings here, so the parse
    // cannot throw for registry-selected values. The block is a readable
    // document, so it drops the compact cell's italic object hint.
    if (typeof value === "string") {
      const parsed: unknown = JSON.parse(value);
      // Re-stringifying is only safe when the parse round-trip is lossless:
      // JSON numbers beyond 2^53 (or non-canonical forms like 1.50) would
      // otherwise display and copy with silently altered digits. Lossy inputs
      // keep the stored text as-is, whitespace preserved.
      if (stripJsonWhitespace(value) === JSON.stringify(parsed)) {
        return { text: JSON.stringify(parsed, null, 2), className: "text-fg-secondary", preserveWhitespace: true };
      }
      return { text: value, className: "text-fg-secondary", preserveWhitespace: true };
    }
    return { text: JSON.stringify(value, null, 2), className: "text-fg-secondary", preserveWhitespace: true };
  },
};
