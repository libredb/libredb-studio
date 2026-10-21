import { readADONetTLS } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `mssql`: the `mssql://` scheme, the ADO.NET Encrypt/TrustServerCertificate pair in its URL query, no seed load check. */
export const MSSQL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "mssql",
  readTls: (params) => readADONetTLS((key) => params.get(key)?.value),
  validateSeed: null,
};
