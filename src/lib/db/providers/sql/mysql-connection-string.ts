import { mapTLSValue, parseGenericURL, readBooleanTLS } from "@/lib/db/connection-string/shared";
import type {
  ConnectionStringPasteReader,
  QueryParams,
  TLSIntent,
  UrlTlsReader,
} from "@/lib/db/connection-string/types";
import type { SSLMode } from "@/lib/types";

/**
 * MySQL's --ssl-mode, minus PREFERRED for the same reason `prefer` is absent from postgres's
 * `POSTGRES_SSLMODE`. VERIFY_IDENTITY checks the hostname as well as the chain, which is what
 * verify-full means here.
 */
const MYSQL_SSL_MODE: Readonly<Record<string, SSLMode>> = {
  disabled: "disable",
  required: "require",
  verify_ca: "verify-ca",
  verify_identity: "verify-full",
};

/** The TLS a mysql URL carries in its query string. */
function readMysqlTLS(params: QueryParams): TLSIntent {
  const mode = params.get("ssl-mode") ?? params.get("sslmode");
  if (mode) return mapTLSValue(mode, MYSQL_SSL_MODE);
  // Reading only ssl-mode dropped `?ssl=true` and `?useSSL=true` with no mode and no
  // banner - the silent downgrade the whole TLS read exists to prevent. mysql2 also
  // accepts an OBJECT here (`ssl={"rejectUnauthorized":true}`); that is not a boolean, so
  // it falls through to the banner rather than being guessed at.
  const flag = params.get("ssl") ?? params.get("usessl");
  return flag ? readBooleanTLS(flag) : {};
}

const claimsMysql = (text: string): boolean => text.startsWith("mysql://");

/** `mysql`'s URL TLS reader: the TLS its URL query carries. */
export const MYSQL_URL_TLS: UrlTlsReader = readMysqlTLS;

/** `mysql`'s paste reader, of `mysql://`. */
export const MYSQL_PASTE_READER: ConnectionStringPasteReader = Object.freeze({
  claims: claimsMysql,
  names: claimsMysql,
  parse: (text: string) => parseGenericURL(text, "mysql", "3306", readMysqlTLS),
});
