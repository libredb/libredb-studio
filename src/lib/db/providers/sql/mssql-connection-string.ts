import { parseGenericURL, readADONetTLS } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection, QueryParams, TLSIntent } from "@/lib/db/connection-string/types";

/** The ADO.NET Encrypt/TrustServerCertificate pair, read from an `mssql://` URL's query. */
const readMssqlTLS = (params: QueryParams): TLSIntent => readADONetTLS((key) => params.get(key)?.value);

/** ADO.NET format: Server=host;Database=db;User Id=user;Password=pass; */
function parseADONetString(input: string): ParsedConnection | null {
  try {
    const params: Record<string, string> = {};
    input.split(";").forEach((part) => {
      const eq = part.indexOf("=");
      if (eq > 0) {
        const key = part.slice(0, eq).trim().toLowerCase();
        const val = part.slice(eq + 1).trim();
        params[key] = val;
      }
    });

    const host = params["server"] || params["data source"] || "localhost";
    const rest = {
      user: params["user id"] || params["uid"] || undefined,
      password: params["password"] || params["pwd"] || undefined,
      database: params["database"] || params["initial catalog"] || undefined,
      ...readADONetTLS((key) => params[key]),
    };

    // SqlClient accepts a protocol prefix on the server, and the Azure portal always
    // writes one (`tcp:<server>.database.windows.net,1433`). tedious resolves the value
    // as a hostname, so a kept prefix fails as ENOTFOUND. TCP is the only protocol
    // tedious speaks: `tcp:` is dropped, `np:` and `lpc:` are reported instead of guessed.
    const protocol = /^(tcp|np|lpc):/i.exec(host);
    if (protocol && protocol[1].toLowerCase() !== "tcp") {
      return { type: "mssql", unsupportedServerProtocol: protocol[1], ...rest };
    }
    const [hostPart, portPart] = host.slice(protocol ? protocol[0].length : 0).split(",");

    return {
      type: "mssql",
      host: hostPart || "localhost",
      port: portPart || "1433",
      ...rest,
    };
  } catch {
    return null;
  }
}

/** The ADO.NET keyword form, whose `Server=` key is matched case-insensitively. */
const ADO_NET = /^Server\s*=/i;

const claimsMssql = (text: string): boolean =>
  text.startsWith("mssql://") || text.startsWith("sqlserver://") || ADO_NET.test(text);

/**
 * `mssql`: the `mssql://` scheme, the ADO.NET Encrypt/TrustServerCertificate pair in its URL query, a paste of
 * `mssql://`, `sqlserver://` or the ADO.NET form `Server=...;`, no seed load check.
 */
export const MSSQL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "mssql",
  readTls: readMssqlTLS,
  paste: {
    catchAll: false,
    claims: claimsMssql,
    names: claimsMssql,
    parse: (text) =>
      ADO_NET.test(text) ? parseADONetString(text) : parseGenericURL(text, "mssql", "1433", readMssqlTLS),
    formats: ["mssql://", "Server=… (ADO.NET)"],
  },
  validateSeed: null,
};
