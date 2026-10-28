import { safeDecodeURIComponent, withSSLMode } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";

/**
 * Parse a Couchbase connection string. Only the management port is stored — 8091 for
 * couchbase://, 18091 for couchbases:// — because the query ports are discovered from the
 * cluster at connect time. A Capella endpoint (couchbases://cb.<id>.cloud.couchbase.com)
 * carries neither a port nor a bucket path, so both stay at their defaults and no bucket
 * is invented. The pasted string is preserved up to the scheme's case (#1916).
 */
function parseCouchbaseString(uri: string, defaultPort: string): ParsedConnection | null {
  try {
    const url = new URL(uri);
    // Multi-node connection strings list hosts comma-separated; take the first one.
    const [firstHost] = url.hostname.split(",");
    const bucket = url.pathname.slice(1); // remove leading /

    return {
      type: "couchbase",
      host: firstHost || "localhost",
      port: url.port || defaultPort,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: bucket ? safeDecodeURIComponent(bucket) : undefined,
      connectionString: uri,
    };
  } catch {
    return null;
  }
}

/**
 * A `couchbases://` or `couchbase://` paste. The TLS scheme is checked first, it is not a prefix of the plain one.
 * The mode travels for the same reason as ClickHouse's: this provider talks HTTP,
 * and `CouchbaseHttpTransport` picks `https` vs `http` from `config.ssl`, never from
 * the pasted string it also stores. Without the mode a `couchbases://` paste posts
 * plain HTTP to 18091. `require` for the same reason as Redis: Capella's certificate
 * is CA-signed, a self-hosted cluster's is not, and only the panel should turn
 * verification on.
 */
function parseCouchbasePaste(text: string): ParsedConnection | null {
  if (text.startsWith("couchbases://")) return withSSLMode(parseCouchbaseString(text, "18091"), "require");
  return withSSLMode(parseCouchbaseString(text, "8091"), "disable");
}

const claimsCouchbase = (text: string): boolean => text.startsWith("couchbase://") || text.startsWith("couchbases://");

/**
 * `couchbase`: the `couchbase://` scheme, no TLS in the URL query (for `couchbases://` the scheme IS the transport and
 * already decided), a paste of `couchbase://` or `couchbases://`, no seed load check.
 */
export const COUCHBASE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "couchbase",
  readTls: null,
  paste: {
    catchAll: false,
    claims: claimsCouchbase,
    names: claimsCouchbase,
    parse: parseCouchbasePaste,
    formats: ["couchbase://"],
  },
  validateSeed: null,
};
