import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `weaviate`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const WEAVIATE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
