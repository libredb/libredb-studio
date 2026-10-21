import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `mongodb`: the `mongodb://` scheme, no TLS read here, no seed load check.
 *
 * MongoDB's URI TLS is read by `readMongoTLS`, which parses it by hand because `mongodb+srv://` is not a URL the
 * query-string reader's caller can build.
 */
export const MONGODB_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "mongodb",
  readTls: null,
  validateSeed: null,
};
