/**
 * Apache Druid cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints
 * after its header, in place of any DDL.
 *
 * The migration text carries no transaction wrapper (#284): `druid` has no transaction concept to translate the
 * wrapper into ("Druid SQL has no ALTER TABLE", the reason below; a datasource is rewritten by an MSQ task, not by a
 * bracketed statement list).
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Druid SQL has no ALTER TABLE; rewrite the datasource with REPLACE INTO through an MSQ task.";

export const DRUID_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Apache Druid: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
