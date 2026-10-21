import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `clickhouse`: the `clickhouse://` scheme, no TLS in the URL query (for its `http(s)://` the scheme IS the transport and already decided), no seed load check. */
export const CLICKHOUSE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "clickhouse",
  readTls: null,
  validateSeed: null,
};
