import { mapTLSValue } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, QueryParams, TLSIntent } from "@/lib/db/connection-string/types";
import type { SSLMode } from "@/lib/types";

/**
 * Db2's `security=` keyword: `SSL` is the one value that names a TLS transport (#786). It maps to
 * a VERIFYING mode, by D26's rule and because the Db2 provider fails closed on unverified
 * transport: without TLS the password crosses the network in cleartext.
 */
const DB2_SECURITY: Readonly<Record<string, SSLMode>> = { ssl: "verify-system" };

/** Db2's boolean `ssl=`, both ends mappable, onto the mode `security=SSL` reads as (#786). */
const DB2_SSL: Readonly<Record<string, SSLMode>> = {
  true: "verify-system",
  "1": "verify-system",
  false: "disable",
  "0": "disable",
};

/** The TLS a db2 URL carries in its query string. */
function readDb2TLS(params: QueryParams): TLSIntent {
  // `security=SSL` is the keyword Db2's own CLI and JDBC drivers read; `ssl` is the boolean
  // spelling other URLs carry. Both ask for a verifying mode: see `DB2_SECURITY`.
  const security = params.get("security");
  if (security) return mapTLSValue(security, DB2_SECURITY);
  const ssl = params.get("ssl");
  return ssl ? mapTLSValue(ssl, DB2_SSL) : {};
}

/** `db2`: the `db2://` scheme, the TLS its URL query carries, no seed load check. */
export const DB2_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "db2",
  readTls: readDb2TLS,
  validateSeed: null,
};
