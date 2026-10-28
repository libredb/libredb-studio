import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `prometheus`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const PROMETHEUS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
