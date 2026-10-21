import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `couchbase`: the `couchbase://` scheme, no TLS in the URL query (for `couchbases://` the scheme IS the transport and already decided), no seed load check. */
export const COUCHBASE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "couchbase",
  readTls: null,
  validateSeed: null,
};
