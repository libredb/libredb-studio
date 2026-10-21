import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `spark`: no connection string scheme, no TLS read from a URL query, no seed load check.
 *
 * Apache Spark has no scheme on purpose, though its `sc://` address is pasted and decomposed (`parseSparkConnectUri`):
 * the login signature prints every scheme with the tail `user@db.internal:<port>/app`, and Spark's grammar
 * refuses both a user part and a path, so the hero would show an address the product refuses.
 */
export const SPARK_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
