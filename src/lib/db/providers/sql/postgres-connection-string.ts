import { mapTLSValue, readBooleanTLS } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, QueryParams, TLSIntent } from "@/lib/db/connection-string/types";
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

/** `postgres`: the `postgres://` scheme, the TLS its URL query carries, no seed load check. */
export const POSTGRES_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "postgres",
  readTls: readPostgresTLS,
  validateSeed: null,
};
