import { parseGenericURL, withSSLMode } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";

/**
 * A ClickHouse paste. The HTTP endpoint IS the connection target, so a bare http(s) URL is
 * as canonical as the clickhouse:// scheme. 8123 rather than 9000 because the provider speaks HTTP, never the native
 * protocol the CLI's clickhouse:// URIs point at; https:// defaults to the server's
 * https_port instead. The result is field-based (no connectionString), so the pasted
 * URL never has to be re-parsed at connect time.
 * The three schemes differ in what they say about TLS, and each has to be able to
 * OVERWRITE a mode the form already carries - pasting is not a merge:
 *   clickhouse:// names no transport  -> say nothing, defer to the form
 *   http://       explicitly plaintext -> disable, or a stale "require" survives
 *   https://      explicitly TLS       -> require, or a Cloud endpoint gets plain HTTP
 */
function parseClickHousePaste(text: string): ParsedConnection | null {
  if (text.startsWith("clickhouse://")) return parseGenericURL(text, "clickhouse", "8123", null);
  if (text.startsWith("http://")) return withSSLMode(parseGenericURL(text, "clickhouse", "8123", null), "disable");
  return withSSLMode(parseGenericURL(text, "clickhouse", "8443", null), "require");
}

const claimsClickHouse = (text: string): boolean =>
  text.startsWith("clickhouse://") || text.startsWith("http://") || text.startsWith("https://");

/**
 * `clickhouse`: the `clickhouse://` scheme, no TLS in the URL query (for its `http(s)://` the scheme IS the transport
 * and already decided), a paste of `clickhouse://`, `http://` or `https://`, no seed load check.
 *
 * Its paste is the catch-all: `http://` and `https://` are every HTTP engine's transport, so ClickHouse takes them
 * only when no row claims the text as its own spelling (an `https://` Snowflake host does).
 */
export const CLICKHOUSE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "clickhouse",
  readTls: null,
  paste: {
    catchAll: true,
    claims: claimsClickHouse,
    names: claimsClickHouse,
    parse: parseClickHousePaste,
    formats: ["clickhouse://", "http(s)://"],
  },
  validateSeed: null,
};
