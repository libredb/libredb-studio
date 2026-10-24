/**
 * Not a table store (#1566 spec 3.5): a collection's properties and vectors are declared through Weaviate's own
 * schema API, and this console writes nothing, so a schema diff gets no table DDL. The sentence is the one `refusal`
 * prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `weaviate` text is a Weaviate console request, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A collection's properties and vectors are declared through Weaviate's own schema API, not SQL DDL, so there is no column definition to change.";

export const WEAVIATE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Weaviate: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
