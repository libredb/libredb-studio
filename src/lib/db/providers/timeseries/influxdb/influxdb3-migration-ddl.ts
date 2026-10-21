/**
 * The same for InfluxDB 3, whose SQL is a read surface: the 3.x planner refuses DDL and DML. The sentence is the one
 * `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `influxdb3` text is SQL, but the 3.x planner takes no
 * DDL, so there is no table DDL to wrap.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A table's tags and fields are created by the line protocol written to it, and InfluxDB 3's SQL takes no DDL, so there is no column definition to change.";

export const INFLUXDB3_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- InfluxDB 3 (SQL): Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
