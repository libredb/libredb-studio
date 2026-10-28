import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `druid`: no connection string scheme (Druid is reached over plain HTTP through the form), no TLS read from a URL query, no seed load check. */
export const DRUID_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
