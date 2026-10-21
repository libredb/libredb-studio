/**
 * Not a table store either: a label groups nodes, each carrying whatever properties it was written with, and the
 * columns the object browser shows are the property keys the server reports for that label. The provider is read-only
 * besides. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `neo4j` text is a Cypher statement, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A node label groups nodes whose properties are not declared columns, so there is no column definition to change.";

export const NEO4J_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Neo4j: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
