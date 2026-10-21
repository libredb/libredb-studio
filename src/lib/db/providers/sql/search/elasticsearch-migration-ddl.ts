/**
 * Elasticsearch cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints
 * after its header, in place of any DDL.
 *
 * Measured 2026-08-19: `ALTER TABLE probe_orders ADD COLUMN x INT` and `... MODIFY COLUMN customer TEXT` are refused
 * by Elasticsearch 9.1.4 with `parsing_exception`, "mismatched input 'ALTER' expecting {'(', 'DEBUG', 'DESC',
 * 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}" (the grammar lists everything it accepts, and no DDL is
 * among them). A mapping is also not editable in place even outside SQL: an existing field's type cannot be changed
 * at all, which is why the reason says reindex rather than "use the mapping API".
 *
 * The migration text carries no transaction wrapper (#284): `elasticsearch` does not have `BEGIN` in its grammar at
 * all - the parse error quoted above lists every statement Elasticsearch SQL accepts and `BEGIN` is not among them.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Elasticsearch SQL reads only; change a field by reindexing into an index whose mapping declares it.";

export const ELASTICSEARCH_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Elasticsearch: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
