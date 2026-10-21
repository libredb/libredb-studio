import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `opensearch`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const OPENSEARCH_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
