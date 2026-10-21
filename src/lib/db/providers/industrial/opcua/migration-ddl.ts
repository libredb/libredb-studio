/**
 * Not a table store (#1677): a node has ATTRIBUTES defined by its type in the server's own model, and this provider
 * has no code that can write one. The sentence is the one `refusal` prints when it declines the whole diff.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "An OPC UA node has attributes defined by its type in the server's own model, not columns, and this provider has no code that can write to a server, so there is no column definition to change.";

export const OPCUA_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- OPC UA: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
