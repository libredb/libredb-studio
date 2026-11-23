import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";

/**
 * RabbitMQ's row of the confirmation gate's vocabulary (#1656).
 *
 * A read request reads a stream's messages and nothing else, so no destructive verb exists to read and nothing is
 * posted for an AI analysis.
 */
export const RABBITMQ_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
};
