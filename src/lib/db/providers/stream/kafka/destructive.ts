import type { DestructiveVocabulary, OperationReader } from "@/lib/db/destructive-vocabulary";

/**
 * Kafka read-request operations that destroy or change anything: none, so the set is empty.
 *
 * Not an omission. The editor text is one JSON read request (#1088, section 5.1): a topic, a
 * partition, where to start and how many messages, and the provider refuses any other key. It
 * names no operation at all, and the provider sends nothing that writes: it never produces,
 * commits an offset, joins a group or creates a topic, and `tests/unit/db/kafka/seam-guard.test.ts`
 * holds the one file that calls its client library to an allowlist of reads (#1088, section 2).
 */
const KAFKA_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/**
 * What a Kafka buffer would run: never an operation this gate asks about.
 *
 * Nothing to resolve here either: whatever the text says, the provider either parses it as one
 * read of one topic's messages or refuses it before anything is sent, so text it cannot parse
 * changes nothing and asks nothing.
 */
const readKafkaOperations: OperationReader = () => [];

/** Kafka's row of the confirmation gate's vocabulary. */
export const KAFKA_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: KAFKA_DESTRUCTIVE_OPERATIONS,
  read: readKafkaOperations,
  decidesAlone: true,
};
