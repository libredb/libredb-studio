/**
 * Not a table store either (vector-family spec 5.3): a collection's schema is declared through Milvus's own
 * collection API, and the columns the object browser shows are its fields. The sentence is the one `refusal` prints
 * when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `milvus` text is a Milvus console request, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A collection's schema is declared through Milvus's own collection API, not SQL DDL, so there is no column definition to change.";

export const MILVUS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Milvus: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
