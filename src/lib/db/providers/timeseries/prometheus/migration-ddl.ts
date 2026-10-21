/**
 * Not a table store at all (#1085): a metric is whatever scrapes and recording rules write under its name, and the
 * HTTP API declares no column anywhere. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `prometheus` text is PromQL, not SQL
 * (`readsSqlText: false` in its `sql-grammar` module). `refusal` declines its whole diff before any wrapper is written.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A metric is written by scrapes and recording rules, not declared with columns, so there is no column definition to change.";

export const PROMETHEUS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Prometheus: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
