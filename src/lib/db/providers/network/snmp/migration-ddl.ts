/**
 * SNMP cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints after its
 * header, in place of any DDL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "An SNMP object's type is declared in the MIB module the device was built with, not in columns a client can change, and this provider's valve refuses any PDU that is not a Get, GetNext or GetBulk, so there is no column definition to change.";

export const SNMP_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- SNMP: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
