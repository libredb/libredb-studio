/**
 * Not a table store either (#1722): a data item's shape is declared in the agent's own device model, which no client
 * writes, and every route this provider sends is a GET.
 *
 * One container level of devices and no schema, so no table DDL to decline (#1722), and no table DDL to wrap either:
 * an agent's model is the agent's own.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "An MTConnect data item's shape is declared in the agent's own device model, not in columns a client can change, and every request this provider sends is a GET, so there is no column definition to change.";

export const MTCONNECT_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- MTConnect: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
