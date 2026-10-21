/**
 * Not a table store either (#1720): a metric's shape is declared by the birth certificate the edge node publishes,
 * and this provider's encoder has no function that writes a PUBLISH, so there is nothing a client here could change.
 *
 * One container level of edge nodes and no schema; a metric's shape is the birth certificate's, and the encoder has
 * no function that writes a PUBLISH (#1720). No table DDL to wrap either: a birth certificate is the edge node's own.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A Sparkplug metric's shape is declared in the birth certificate its edge node publishes, not in columns a client can change, and this provider's encoder has no function that writes a PUBLISH, so there is no column definition to change.";

export const SPARKPLUG_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Sparkplug B: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
