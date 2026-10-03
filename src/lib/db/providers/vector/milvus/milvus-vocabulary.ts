/**
 * Milvus's native vocabulary mapped onto the shared one (vector-family spec 3.3, 5.5, 5.11): metrics to score
 * semantics and the score column's text, and field types to the type text a result and the tree show. Pure.
 */
import { scoreColumnType } from "@/lib/db/vector/score";
import type { ScoreSemantics, VectorMetric } from "@/lib/db/vector/types";
import type { WireFieldSchema, WireFunctionSchema } from "./client";
import type { ScoreSource } from "./request";

const METRICS: Readonly<Record<string, { readonly kind: "similarity" | "distance"; readonly metric: VectorMetric }>> = {
  COSINE: { kind: "similarity", metric: "cosine" },
  IP: { kind: "similarity", metric: "dot" },
  // Milvus computes L2 before the square root: (3,4) from the origin scores 25 (3.3).
  L2: { kind: "distance", metric: "euclidean_squared" },
  HAMMING: { kind: "distance", metric: "hamming" },
  JACCARD: { kind: "distance", metric: "jaccard" },
  BM25: { kind: "similarity", metric: "other" },
  MHJACCARD: { kind: "distance", metric: "other" },
};

/**
 * What a score under `metric` means. A metric not in the table, the MAX_SIM family of embedding-list search among
 * them, claims no direction: its rows are in rank order, until a live run measures one (3.3).
 */
export function scoreSemantics(metric: string): ScoreSemantics {
  const known = Object.hasOwn(METRICS, metric) ? METRICS[metric] : undefined;
  if (known === undefined) return { kind: "similarity", better: null, metric: "other", nativeName: metric };
  return {
    kind: known.kind,
    better: known.kind === "similarity" ? "higher" : "lower",
    metric: known.metric,
    nativeName: metric,
  };
}

/** The `columnTypes` text of the `distance` column (3.3, 5.5). */
export function scoreColumnText(score: ScoreSource): string {
  switch (score.kind) {
    case "metric":
      return scoreColumnType(scoreSemantics(score.metric));
    case "fused":
      return scoreColumnType({
        kind: "fused",
        better: "higher",
        metric: null,
        nativeName: score.strategy === "rrf" ? "RRF" : "weighted",
      });
    case "unreadable":
      return "Float, metric not readable without IndexDetail, rows are in rank order";
    case "unreported":
      return "Float, no index reported for the field, rows are in rank order";
  }
}

/** The types Studio does not decode: their cells are empty, with a warning (5.5). */
export const UNDECODED_TYPES: readonly string[] = ["Decimal", "Date", "Time", "Mol"];

function param(field: WireFieldSchema, key: string): string {
  return field.type_params.find((entry) => entry.key === key)?.value ?? "?";
}

/**
 * A field's type as Studio spells it everywhere: `FloatVector(768)`, `VarChar(256)`, `Array<Int64>(8)`, a function
 * output with its function, `SparseFloatVector(BM25: text_bm25)` (5.3, 5.5).
 */
export function fieldTypeText(field: WireFieldSchema, functions: readonly WireFunctionSchema[]): string {
  if (field.is_dynamic) return "JSON (dynamic)";
  if (UNDECODED_TYPES.includes(field.data_type)) return `${field.data_type} (not supported)`;
  switch (field.data_type) {
    case "VarChar":
      return `VarChar(${param(field, "max_length")})`;
    case "Array":
      return `Array<${field.element_type}>(${param(field, "max_capacity")})`;
    case "FloatVector":
    case "Float16Vector":
    case "BFloat16Vector":
    case "Int8Vector":
    case "BinaryVector":
      return `${field.data_type}(${param(field, "dim")})`;
    case "SparseFloatVector": {
      const producer = functions.find((fn) => fn.output_field_names.includes(field.name));
      return producer === undefined ? "SparseFloatVector" : `SparseFloatVector(${producer.type}: ${producer.name})`;
    }
    default:
      return field.data_type;
  }
}
