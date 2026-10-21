/**
 * Not a table store either (vector-family spec 6.3): a collection holds points whose payloads are schemaless, and the
 * columns the object browser shows are its vectors, its payload indexes and a sample of its payload keys. The
 * sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `qdrant` text is a Qdrant console request, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A collection's payloads are schemaless and its vectors are declared through Qdrant's own collection API, not SQL DDL, so there is no column definition to change.";

export const QDRANT_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Qdrant: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
