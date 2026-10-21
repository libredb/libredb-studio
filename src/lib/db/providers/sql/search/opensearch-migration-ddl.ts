/**
 * OpenSearch cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints
 * after its header, in place of any DDL.
 *
 * Measured 2026-08-19: `ALTER TABLE probe_orders ADD COLUMN x INT` and `... MODIFY COLUMN customer TEXT` are refused
 * by OpenSearch 3.8.0 with `SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or
 * DESCRIBE". A mapping is also not editable in place even outside SQL: an existing field's type cannot be changed at
 * all, which is why the reason says reindex rather than "use the mapping API".
 *
 * The migration text carries no transaction wrapper (#284): `opensearch` does not have `BEGIN` in its grammar at all,
 * measured on OpenSearch 3.8.0 (`docs/providers/opensearch.md` §9).
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "OpenSearch SQL reads only; change a field by reindexing into an index whose mapping declares it.";

export const OPENSEARCH_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- OpenSearch: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
