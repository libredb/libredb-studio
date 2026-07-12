import type { ValueRenderer } from "./types";

export const nullRenderer: ValueRenderer = {
  kind: "null",
  renderCompact() {
    return { display: "NULL", className: "text-zinc-600 italic" };
  },
};
