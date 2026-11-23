import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * MQTT's row of the confirmation gate's vocabulary (#1635).
 *
 * There is no console and no statement, so nothing is ever read for a destructive verb. The row exists because the
 * record is exhaustive over every engine whose text is not SQL, and its operations list is empty by construction:
 * this provider has no code that can write to a broker.
 */
export const MQTT_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
