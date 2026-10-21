/**
 * Not a table store either (#1088): a topic holds messages whose keys and values are bytes the producers chose, and
 * the broker declares no column anywhere; the columns the object browser shows are the fixed shape of a read result.
 * The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `kafka` text is a JSON read request, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "A topic holds messages, not rows with declared columns, so there is no column definition to change.";

export const KAFKA_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Apache Kafka: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
