import type { ConnectionStringSpec } from "./types";

/** What a reader gets with no connection: no scheme, no TLS from a URL query (`{}`), no load check. */
export const NO_CONNECTION_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
