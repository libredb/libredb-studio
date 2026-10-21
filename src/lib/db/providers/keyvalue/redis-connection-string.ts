import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `redis`: the `redis://` scheme, no TLS in the URL query (for `rediss://` the scheme IS the transport and already decided), no seed load check. */
export const REDIS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "redis",
  readTls: null,
  validateSeed: null,
};
