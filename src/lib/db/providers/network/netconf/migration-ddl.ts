/**
 * Not a table store either (#1724): a node's shape is declared in the device's own YANG module, which the device
 * serves and a client only reads, and this provider builds four read operations and a close, so there is no statement
 * in it that could change a definition.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A NETCONF node's shape is declared in the device's YANG module, which the device serves and a client reads, and this provider builds four read operations and a close, and nothing else, so there is no column definition here for anything to change.";

export const NETCONF_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- NETCONF: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
