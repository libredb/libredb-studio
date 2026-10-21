/**
 * Not a table store either (SB2-4.3): a key holds opaque bytes, and the columns a read shows are a record's fixed
 * shape. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `oxia` text is one `oxia client` read command, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "Oxia stores opaque values under string keys and has no schema, so there is no column definition to change.";

export const OXIA_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Oxia: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
