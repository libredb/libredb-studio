import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * MTConnect's row of the confirmation gate's vocabulary (#1722).
 *
 * The console reads one request line from a closed table of nine routes, every one a GET, so there is no destructive
 * verb to find. The row names no operation ON PURPOSE, in the shape Prometheus and Kafka use: naming one would claim
 * this provider can send it.
 */
export const MTCONNECT_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
