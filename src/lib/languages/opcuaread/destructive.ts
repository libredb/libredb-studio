import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * OPC UA's row of the confirmation gate's vocabulary (#1677).
 *
 * The console reads one JSON read request, so there is no destructive verb to find. The row exists because the record
 * is exhaustive over every engine whose text is not SQL, and its operations list is empty by construction: the client
 * seam names eight read services and none of them writes.
 */
export const OPCUA_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
