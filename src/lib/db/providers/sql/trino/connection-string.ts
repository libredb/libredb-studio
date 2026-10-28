import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `trino`: no connection string scheme, no TLS read from a URL query, no seed load check.
 *
 * Trino is the sharpest version of the scheme gap, and worth naming because it looks like it
 * belongs among the schemes: it HAS a canonical URL, `jdbc:trino://host:port/catalog/schema`. That is
 * a JDBC URL and not a URI - `new URL()` reads its scheme as `jdbc:` - and stripping the
 * prefix to make one would invent a `trino://` form no Trino tool emits. So the scheme is
 * `null`, its capabilities say `supportsConnectionString: false`, and its form offers no
 * paste toggle. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 */
export const TRINO_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
