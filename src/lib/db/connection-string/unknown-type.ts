import type { ConnectionStringSpec } from "./types";

/** What a type string that names no shipped engine gets: no scheme, no TLS from a URL query (`{}`), no load check. */
export const UNKNOWN_TYPE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
