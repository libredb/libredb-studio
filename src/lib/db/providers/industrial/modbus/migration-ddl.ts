/**
 * One container level of unit ids and no schema; a register has no definition to alter, and the provider has no code
 * that could write one (#1723).
 *
 * No table DDL to wrap either (#1723): what a register means is the device vendor's, written down in the user's map
 * rather than in anything a client could migrate.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A Modbus register has no column definition anywhere: the device holds 16-bit words and single bits with no name, no type and no unit, and what gives them meaning is the register map the user wrote, so there is nothing a client could change here.";

export const MODBUS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Modbus: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
