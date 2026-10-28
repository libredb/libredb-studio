import {
  mapTLSValue,
  parseGenericURL,
  readBooleanTLS,
  safeDecodeURIComponent,
} from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection, QueryParams, TLSIntent } from "@/lib/db/connection-string/types";
import type { SSLMode } from "@/lib/types";

/**
 * libpq's sslmode, minus `prefer` and `allow`. Those two are absent on purpose (see the
 * `unmappedTLSParam` note): they mean "encrypt if the server offers it", which no SSLMode
 * value describes. `verify-system` is not in the table either - it is this form's own mode
 * name and not a libpq one, so a string carrying it is a string we cannot honour.
 */
const POSTGRES_SSLMODE: Readonly<Record<string, SSLMode>> = {
  disable: "disable",
  require: "require",
  "verify-ca": "verify-ca",
  "verify-full": "verify-full",
};

/**
 * The TLS a postgres URL carries in its query string.
 *
 * Postgres's sslrootcert/sslcert/sslkey are read by nobody here on purpose: they name files on
 * the machine that wrote the string, while the form holds PEM text and the process that opens
 * the connection is the server, which cannot read that path.
 */
function readPostgresTLS(params: QueryParams): TLSIntent {
  // The explicit mode wins over the boolean: a string carrying both said the specific
  // thing on purpose.
  const sslmode = params.get("sslmode");
  if (sslmode) return mapTLSValue(sslmode, POSTGRES_SSLMODE);
  const ssl = params.get("ssl");
  return ssl ? readBooleanTLS(ssl) : {};
}

/**
 * The libpq connection keywords a postgres URL may carry as query parameters
 * (PostgreSQL docs, "Connection Strings": every keyword is accepted in the
 * query part, e.g. postgresql:///mydb?host=db.example.com&port=5433).
 * Mapped onto the field each one fills; `dbname` is handled separately because
 * libpq lets it disagree with the path.
 */
const POSTGRES_QUERY_PARAMETERS: Readonly<Record<string, "host" | "port" | "user" | "password">> = {
  host: "host",
  port: "port",
  user: "user",
  password: "password",
};

/**
 * The postgres URL query string, split and decoded the way libpq splits it
 * (fe-connect.c, `conninfo_uri_parse_params`): each pair on its first `=`,
 * one percent-decode pass (a `+` is a literal plus, since libpq's
 * `conninfo_uri_decode` only handles `%XX`), and a later occurrence of a
 * keyword replaces an earlier one, because libpq stores each value as it
 * walks the pairs. Malformed escapes are kept verbatim rather than rejecting
 * the URL, the way the rest of the paste readers treat them.
 */
function postgresQueryParameter(url: URL): (name: string) => string | null {
  const values = new Map<string, string>();
  for (const pair of url.search.slice(1).split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    values.set(safeDecodeURIComponent(pair.slice(0, equals)), safeDecodeURIComponent(pair.slice(equals + 1)));
  }
  return (name: string) => values.get(name) ?? null;
}

/** An authority that is only a userinfo (`postgresql://@/db`): valid for libpq, rejected by the URL constructor. */
const EMPTY_HOST_AUTHORITY = /^(postgres(?:ql)?:\/\/[^/?#]*@)(?=[/?])/;

function parsePostgresURL(uri: string): ParsedConnection | null {
  // `postgresql://@/db` and `postgresql://user@/db` carry only a userinfo and
  // no host; libpq accepts them, the URL constructor does not. The empty host
  // becomes `localhost` first, the same host the plain `postgresql:///db`
  // form reads as, and a query `host=` still replaces it.
  const normalized = uri.replace(EMPTY_HOST_AUTHORITY, "$1localhost");
  const parsed = parseGenericURL(normalized, "postgres", "5432", readPostgresTLS);
  if (parsed === null) return null;
  const url = new URL(normalized);
  const queryValue = postgresQueryParameter(url);
  for (const [name, field] of Object.entries(POSTGRES_QUERY_PARAMETERS)) {
    const value = queryValue(name);
    if (value !== null) {
      parsed[field] = value;
    }
  }
  const dbname = queryValue("dbname");
  if (dbname !== null) {
    parsed.database = dbname;
  }
  return parsed;
}

/** `postgres://` and `postgresql://`. */
const claimsPostgres = (text: string): boolean => text.startsWith("postgres://") || text.startsWith("postgresql://");

/**
 * `postgres`: the `postgres://` scheme, the TLS its URL query carries, a paste of `postgres://` or `postgresql://`
 * read with libpq's query keywords, no seed load check.
 */
export const POSTGRES_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "postgres",
  readTls: readPostgresTLS,
  paste: { catchAll: false, claims: claimsPostgres, names: claimsPostgres, parse: parsePostgresURL },
  validateSeed: null,
};
