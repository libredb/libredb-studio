import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `snmp`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const SNMP_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
