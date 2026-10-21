/**
 * MongoDB cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints after
 * its header, in place of any DDL.
 *
 * The migration text carries no transaction wrapper (#284): `mongodb` writes no SQL text at all (`readsSqlText: false`
 * in its `sql-grammar` module), and wrapping non-SQL command text in SQL statements is wrong regardless of Mongo's
 * own driver-level transaction API.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Collections are schemaless, so there is no column definition to change.";

export const MONGODB_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- MongoDB: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
