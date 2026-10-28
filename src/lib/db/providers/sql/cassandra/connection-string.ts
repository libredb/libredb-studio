import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `cassandra`: no connection string scheme, no TLS read from a URL query, no seed load check.
 *
 * Cassandra has no scheme for a reason stronger than a missing convention: its driver needs
 * a REQUIRED `localDataCenter` alongside the contact points (measured on 4.9.0 - it
 * refuses to construct a client without one), and no URI convention in use carries that
 * field. A `cassandra://host:9042/keyspace` form would therefore parse into a connection
 * that cannot open, which is worse than no paste at all.
 */
export const CASSANDRA_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
