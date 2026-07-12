import type { ValueRenderer } from "./types";

export const scalarRenderer: ValueRenderer = {
  kind: "scalar",
  renderCompact(value) {
    if (typeof value === "number") {
      return { display: String(value), className: "text-amber-500/90 font-medium" };
    }
    if (typeof value === "boolean") {
      return { display: String(value), className: value ? "text-emerald-500/90" : "text-rose-500/90" };
    }
    const display = String(value);
    const strVal = display.toLowerCase();
    if (strVal === "true" || strVal === "active" || strVal === "enabled") {
      return { display, className: "text-emerald-500/90" };
    }
    if (strVal === "false" || strVal === "inactive" || strVal === "disabled") {
      return { display, className: "text-rose-500/90" };
    }
    return { display, className: "text-zinc-300" };
  },
  renderDetail(value) {
    // Scalars have no expanded form — the detail sheet shows the compact text.
    const { display, className } = scalarRenderer.renderCompact(value);
    return { text: display, className, preserveWhitespace: false };
  },
};
