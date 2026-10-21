/**
 * Not a table store (Kubernetes): an object's schema is its API version's, served by the API server, and Studio
 * writes none. The sentence is the one `refusal` prints when it declines the whole diff.
 *
 * The migration text carries no transaction wrapper (#284): `kubernetes` text is one kubectl statement, not SQL.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON =
  "Kubernetes objects follow the schema their API version serves, and Studio writes none, so there is no column definition to change.";

export const KUBERNETES_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Kubernetes: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
