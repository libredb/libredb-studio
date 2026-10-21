/**
 * Not a store at all (#1635): a broker holds messages on topics, and the columns a read shows are the fixed shape of
 * a message. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * No schema and no catalog (#1635), so no table DDL to decline, and no table DDL to wrap either: a broker keeps no
 * schema.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "A broker keeps no schema and no catalog, so there is no column definition to change.";

export const MQTT_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- MQTT: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
