import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/** SNMP's row of the confirmation gate's vocabulary: a read request names no destructive verb. */
export const SNMP_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
