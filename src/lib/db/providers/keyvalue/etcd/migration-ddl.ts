/**
 * Not a table store either (#1089): a key's value is bytes, and a key-prefix group is derived from the key space's
 * shape rather than declared; the columns the object browser shows are the fixed shape of a `get` row. The sentence
 * is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `etcd` text is an etcdctl command line, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "A key-prefix group holds keys whose values are bytes, not rows with declared columns, so there is no column definition to change.";

export const ETCD_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- etcd: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
