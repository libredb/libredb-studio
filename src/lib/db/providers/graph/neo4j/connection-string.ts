import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `neo4j`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const NEO4J_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
