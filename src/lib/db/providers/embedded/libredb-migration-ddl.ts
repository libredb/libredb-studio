/**
 * LibreDB cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints after
 * its header, in place of any DDL.
 *
 * The migration text carries no transaction wrapper (#284): `libredb` "speaks a JSON command grammar, not SQL DDL"
 * (the reason's own words).
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "The embedded engine speaks a JSON command grammar, not SQL DDL.";

export const LIBREDB_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- LibreDB: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
