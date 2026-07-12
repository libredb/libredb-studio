import type { ValueRenderer } from "./types";

export const nullRenderer: ValueRenderer = {
  kind: "null",
  renderCompact() {
    return { display: "NULL", className: "text-zinc-600 italic" };
  },
  renderDetail(value) {
    // Pins the detail sheet's historical output: null rendered as lowercase
    // "null" (typeof null === "object" took the JSON.stringify branch there),
    // undefined as "NULL".
    return { text: value === null ? "null" : "NULL", className: "text-zinc-600 italic", preserveWhitespace: false };
  },
};
