import type { DetailedObject } from "@/lib/db/detailed-object";

/** A text only data could have put in a schema: the name of a key some sampled rows held. */
export const SAMPLED_MARKER = "sampled_key_from_row_data_7f3a";

/**
 * One collection whose first column the engine declares and whose second the provider inferred from sampled rows,
 * which `provenance: "sampled"` marks. Every machine-facing surface holds the first and never the second, and every
 * human view lists both.
 */
export const sampledSchema: readonly DetailedObject[] = [
  {
    name: "articles",
    kind: "table",
    path: ["articles"],
    rowCount: 3,
    columns: [
      { name: "category", type: "keyword", nullable: true, isPrimary: false },
      { name: SAMPLED_MARKER, type: "text", nullable: true, isPrimary: false, provenance: "sampled" },
    ],
    indexes: [{ name: "category_idx", columns: ["category"], unique: false }],
    foreignKeys: [],
  },
];
