import type { MaintenancePreview, ProviderCapabilities } from "@/lib/db/types";

/**
 * A test-only declaration of the per-row maintenance extensions of spec 3.11, which no shipped provider declares.
 *
 * `MaintenanceOperation` is a closed union whose only members outside `MaintenanceType` are etcd's three, so the
 * synthetic per-row operations borrow two of those names: what is tested is the declaration, never the name. The order
 * of `maintenanceOperations` is deliberately not the union's (`disarm` before `compact`), so a surface that sorted by
 * the union instead of following the declaration would fail.
 *
 * - `disarm`, labelled "Release Object": runs on one row and asks for that row's own name; no preview.
 * - `compact`, labelled "Load Object": runs on one row, asks for its name, and shows a preview first.
 * - `defragment`: a whole-database card with a typed confirmation, which no per-row surface may offer.
 */
export const SYNTHETIC_ENTITY_CAPABILITIES = {
  supportsMaintenance: true,
  maintenanceOperations: ["analyze", "disarm", "compact", "defragment"],
  maintenanceOperationSpecs: {
    analyze: { label: "Analyze Table", perEntity: true, global: true },
    disarm: { label: "Release Object", perEntity: true, global: false, confirmation: "typed-target" },
    compact: { label: "Load Object", perEntity: true, global: false, confirmation: "typed-target", preview: true },
    defragment: {
      label: "Defragment",
      title: "Defragment the member",
      description: "Rebuilds the member's database file.",
      perEntity: false,
      global: true,
      confirmation: "typed",
    },
  },
} satisfies Pick<ProviderCapabilities, "supportsMaintenance" | "maintenanceOperations" | "maintenanceOperationSpecs">;

/** What the synthetic `compact` preview answers: two facts and a freshness note, no refusal. */
export const SYNTHETIC_PREVIEW: MaintenancePreview = {
  summary: "Load Object reads users into memory on the server.",
  facts: [
    { label: "State", value: "Not loaded" },
    { label: "Rows (estimate)", value: "1,200" },
  ],
  note: "as reported by the server, possibly several seconds old",
};

/** A preflight that refuses: the dialog shows the sentence and offers no confirm button. */
export const SYNTHETIC_REFUSED_PREVIEW: MaintenancePreview = {
  summary: "Load Object cannot run on users now.",
  facts: [{ label: "State", value: "Loading" }],
  refusal: "This object is still loading on the server; open the preview again once it reads Loaded.",
};
