/**
 * Couchbase cannot apply a relational table diff through SQL, so `refusal` is the one line the migration prints after
 * its header, in place of any DDL. Couchbase has index/collection DDL, but no CREATE/ALTER TABLE column grammar.
 *
 * The migration text carries no transaction wrapper (#284): `couchbase` HAS distributed ACID transactions, but spells
 * one `BEGIN TRANSACTION` and answers with a `txid` that every following statement has to carry as a request
 * parameter (`docs/providers/couchbase.md` §13) - a shape a flat migration file cannot express at all, so `BEGIN;` is
 * both the wrong keyword and the wrong mechanism.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Collections hold schemaless JSON documents, so there is no column definition to change.";

export const COUCHBASE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Couchbase: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
