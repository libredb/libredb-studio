import type { ValueRenderer } from "./types";

export const jsonRenderer: ValueRenderer = {
  kind: "json",
  renderCompact(value) {
    // A JSON string keeps its raw single-line display in the grid; only the
    // detail sheet gives json-kind values the pretty treatment.
    if (typeof value === "string") {
      return { display: value, className: "text-zinc-300" };
    }
    return { display: JSON.stringify(value), className: "text-blue-400/80 italic font-light" };
  },
};
