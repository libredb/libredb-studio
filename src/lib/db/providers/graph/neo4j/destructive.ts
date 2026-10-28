import type { DestructiveVocabulary, OperationReader } from "@/lib/db/destructive-vocabulary";

/**
 * Cypher operations that destroy or change anything and reach the server: none, so the set is empty.
 *
 * Not an omission. Cypher text can write (`CREATE`, `MERGE`, `SET`, `DELETE`, `DROP`), but the provider
 * refuses every write before sending it (Neo4j spec 5.5): the read policy in
 * `src/lib/db/graph/cypher/read-policy.ts` refuses a write word, the server's own EXPLAIN classification
 * refuses what the words miss, and the statement runs in a READ session besides. A confirmation would ask
 * about a statement that cannot run.
 */
const NEO4J_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/**
 * What a Cypher buffer would run: never an operation this gate asks about.
 *
 * Nothing to resolve: the provider either runs the text as one read or refuses it before anything is sent,
 * so a write, and text it cannot lex, changes nothing and asks nothing.
 */
const readNeo4jOperations: OperationReader = () => [];

/**
 * Neo4j's row of the confirmation gate's vocabulary.
 *
 * The provider refuses every write before sending it, so a confirmation would ask about a statement that cannot run
 * (Neo4j spec 5.5).
 */
export const NEO4J_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: NEO4J_DESTRUCTIVE_OPERATIONS,
  read: readNeo4jOperations,
  decidesAlone: true,
};
