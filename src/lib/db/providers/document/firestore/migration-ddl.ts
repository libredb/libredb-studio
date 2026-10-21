/**
 * A document store (Firestore spec 3.3): documents carry their own fields, and the columns a read shows are sampled
 * from them, so there is no column definition to change. The sentence is the one `refusal` prints.
 *
 * No schema and no catalog, so no table DDL to decline, and no table DDL to wrap either: a document store keeps no
 * schema.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "A document store keeps no schema, so there is no column definition to change.";

export const FIRESTORE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Firestore: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
