import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";
import { parseSparkConnectUri } from "@/lib/db/providers/sql/spark/sc-uri";

/** The sc:// address, and the Spark Connect JDBC driver's jdbc:sc:// form, which its reader refuses. */
const claimsSpark = (text: string): boolean => text.startsWith("sc://") || text.startsWith("jdbc:sc://");

/**
 * `spark`: no connection string scheme, no TLS read from a URL query, a paste of `sc://` or `jdbc:sc://`, no seed load
 * check.
 *
 * Apache Spark has no scheme on purpose, though its `sc://` address is pasted and decomposed (`parseSparkConnectUri`):
 * the login signature prints every scheme with the tail `user@db.internal:<port>/app`, and Spark's grammar
 * refuses both a user part and a path, so the hero would show an address the product refuses. Its paste names no
 * type for `detectConnectionStringType`, which has never named Spark.
 */
export const SPARK_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: { catchAll: false, claims: claimsSpark, names: () => false, parse: parseSparkConnectUri },
  validateSeed: null,
};
