/**
 * Not a table store (#1656): a stream holds messages, and the columns a read shows are the fixed shape of a message.
 * The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * No schema and no catalog (#1656), so no table DDL to decline, and no table DDL to wrap either: a broker keeps no
 * schema.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "A stream holds messages, not rows with declared columns, so there is no column definition to change.";

export const RABBITMQ_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- RabbitMQ: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
