/**
 * Not a table store either: a measurement's tags and fields come into being with the points written to it, and the
 * provider is read-only. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `influxdb` text is an InfluxQL statement, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A measurement's tags and fields are created by the points written to it, not declared with columns, so there is no column definition to change.";

export const INFLUXDB_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- InfluxDB (InfluxQL): Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
