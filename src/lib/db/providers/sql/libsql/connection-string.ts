import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";

/**
 * A `libsql://` URL as a connection.
 *
 * TLS always, and the token rides in the query string rather than in the
 * authority: `libsql://<database>-<org>.turso.io?authToken=<jwt>` is what Turso's
 * own CLI prints, and `libsql://` has no plaintext form - a self-hosted server on
 * plain HTTP is reached through the host/port fields with TLS off, because
 * `http://` already resolves to ClickHouse and two engines cannot own one scheme.
 *
 * Three things differ from `parseGenericURL` and each is measured against what Turso
 * emits: the credential is `?authToken=`, so the URL's own password slot is only a
 * fallback; there is no database in the path, because the database IS the hostname;
 * and the default port is 443 under required TLS, which is how Turso Cloud serves
 * every database.
 */
function parseLibSQLURL(uri: string): ParsedConnection | null {
  try {
    const url = new URL(uri);

    return {
      type: "libsql",
      host: url.hostname || "localhost",
      port: url.port || "443",
      password: url.searchParams.get("authToken") ?? (url.password ? decodeURIComponent(url.password) : undefined),
      sslMode: "require",
    };
  } catch {
    return null;
  }
}

const claimsLibSQL = (text: string): boolean => text.startsWith("libsql://");

/** `libsql`: the `libsql://` scheme, no TLS read from the URL query, a paste of `libsql://`, no seed load check. */
export const LIBSQL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "libsql",
  readTls: null,
  paste: { catchAll: false, claims: claimsLibSQL, names: claimsLibSQL, parse: parseLibSQLURL },
  validateSeed: null,
};
