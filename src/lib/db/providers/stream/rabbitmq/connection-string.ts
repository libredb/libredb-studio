import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `rabbitmq`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const RABBITMQ_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
