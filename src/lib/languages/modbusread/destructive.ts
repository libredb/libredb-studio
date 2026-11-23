import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * Modbus's row of the confirmation gate's vocabulary (#1723).
 *
 * The row exists because `readsSqlText` says this engine's text is not SQL, and it names NO operation on purpose, in
 * the shape MTConnect and Prometheus use. The encoder builds four read function codes and the identification request
 * and nothing else, so there is no destructive verb to find; naming one would claim this provider can send it.
 */
export const MODBUS_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
