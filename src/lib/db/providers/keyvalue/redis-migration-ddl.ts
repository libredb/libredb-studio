/**
 * Redis cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints after its
 * header, in place of any DDL.
 *
 * The migration text carries no transaction wrapper (#284): `redis` writes no SQL text at all (`readsSqlText: false` in
 * its `sql-grammar` module), and wrapping non-SQL command text in SQL statements is wrong.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Keys are not tables and have no column definitions to change.";

export const REDIS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Redis: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
