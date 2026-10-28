import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * Sparkplug B's row of the confirmation gate's vocabulary (#1720).
 *
 * A read request names a group, an edge node and a window, so there is no destructive verb to read, and nothing is
 * posted for an AI analysis. The absence is structural: the encoder has no function that writes a PUBLISH, so no
 * console text could change a plant even if one named a verb.
 */
export const SPARKPLUG_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
