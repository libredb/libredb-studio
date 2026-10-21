/**
 * Not a table store either: an object is bytes under a key, and the columns a listing shows are its fixed shape. The
 * sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `s3` text is one AWS CLI subset command, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "S3 stores objects under keys with no schema, so there is no column definition to change.";

export const S3_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- S3-compatible object storage: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
