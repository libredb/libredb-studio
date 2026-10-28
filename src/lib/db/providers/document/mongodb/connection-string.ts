import { readBooleanTLS } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection, RawParam, TLSIntent } from "@/lib/db/connection-string/types";

/**
 * The MongoDB URI's TLS options, read for both schemes.
 *
 * `tls=true` (and the driver's deprecated `ssl=` alias) goes through the boolean rule (D26),
 * and `mongodb+srv://` with no TLS parameter carries the same mode: the driver turns TLS on
 * for every SRV connection itself, WITH verification, so leaving the form on its `disable`
 * default described a connection that is in fact encrypted as one that is not.
 *
 * `tlsInsecure` / `tlsAllowInvalidCertificates` pull the result back down to `require`. Both
 * turn `rejectUnauthorized` off while leaving TLS on (mongodb.d.ts documents the mapping onto
 * the Node names), which is exactly what `require` means here - and the provider sends its
 * options object as a second channel the driver prefers over the URI, so a verifying mode
 * would break a string that connects today. `tlsAllowInvalidHostnames` is NOT in that set: it
 * relaxes the name check only, which our options object never sets, so the URI's own
 * relaxation survives alongside a verifying mode.
 */
function readMongoTLS(uri: string): TLSIntent {
  const params = new Map<string, RawParam>();
  const queryStart = uri.indexOf("?");
  if (queryStart >= 0) {
    for (const [name, value] of new URLSearchParams(uri.slice(queryStart + 1))) {
      params.set(name.toLowerCase(), { name, value });
    }
  }

  const flag = params.get("tls") ?? params.get("ssl");
  const intent: TLSIntent = flag
    ? readBooleanTLS(flag)
    : uri.startsWith("mongodb+srv://")
      ? { sslMode: "verify-system" }
      : {};

  if (intent.sslMode === undefined || intent.sslMode === "disable") return intent;
  const relax = params.get("tlsinsecure") ?? params.get("tlsallowinvalidcertificates");
  if (relax !== undefined && relax.value.toLowerCase() === "true") return { sslMode: "require" };
  // `tlsCAFile` pins the chain to a CA the URI names rather than the system store, which is
  // `verify-ca`: the mode that shows the CA box the paste banner points at (#842).
  return params.has("tlscafile") ? { sslMode: "verify-ca" } : intent;
}

/**
 * MongoDB TLS parameters that name a file path rather than a value SSLMode could express.
 * `tlsCAFile` is the only one reported so far (#842, via AWS DocumentDB's own connection
 * string) - scoped to it rather than the driver's full file-path option set until another
 * is actually seen.
 */
function readMongoTLSFileParam(uri: string): string | undefined {
  const queryStart = uri.indexOf("?");
  if (queryStart < 0) return undefined;
  for (const [name, value] of new URLSearchParams(uri.slice(queryStart + 1))) {
    if (name.toLowerCase() === "tlscafile") return `${name}=${value}`;
  }
  return undefined;
}

function parseMongoDBString(uri: string): ParsedConnection {
  const tlsFileParam = readMongoTLSFileParam(uri);
  const result: ParsedConnection = {
    type: "mongodb",
    connectionString: uri,
    ...readMongoTLS(uri),
    ...(tlsFileParam ? { tlsFileParam } : {}),
  };

  try {
    // For mongodb+srv, we can't use URL directly for host/port
    // but we can extract user/pass/database
    const isSRV = uri.startsWith("mongodb+srv://");

    // Extract database from path
    const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//, "");

    // The authority (credentials + host) ends at the first "/" or "?", where the driver's
    // own grammar ends it, so an "@" in an option value is not counted. More than one
    // literal "@" in it means an unescaped reserved character in the credentials -
    // `p@ss:w#rd@host` - makes the auth/host split ambiguous, so refuse to guess rather
    // than mis-split it (#842). The driver refuses the same string as "Invalid connection
    // string". Percent-encoded credentials (`p%40ss`) never trigger this: the encoded form
    // has exactly one literal "@".
    const authorityEnd = withoutProtocol.search(/[/?]/);
    const authority = authorityEnd >= 0 ? withoutProtocol.slice(0, authorityEnd) : withoutProtocol;
    if ((authority.match(/@/g) ?? []).length > 1) {
      result.credentialsAmbiguous = true;
      return result;
    }

    const atIndex = withoutProtocol.indexOf("@");
    const afterAuth = atIndex >= 0 ? withoutProtocol.slice(atIndex + 1) : withoutProtocol;

    // Split host(s) from path
    const slashIndex = afterAuth.indexOf("/");
    if (slashIndex >= 0) {
      const pathPart = afterAuth.slice(slashIndex + 1);
      const dbName = pathPart.split("?")[0];
      if (dbName) result.database = decodeURIComponent(dbName);
    }

    // Extract credentials
    if (atIndex >= 0) {
      const authPart = withoutProtocol.slice(0, atIndex);
      const colonIndex = authPart.indexOf(":");
      if (colonIndex >= 0) {
        result.user = decodeURIComponent(authPart.slice(0, colonIndex));
        result.password = decodeURIComponent(authPart.slice(colonIndex + 1));
      } else {
        result.user = decodeURIComponent(authPart);
      }
    }

    // Extract host/port for non-SRV
    if (!isSRV && slashIndex >= 0) {
      const hostPart = afterAuth.slice(0, slashIndex);
      const firstHost = hostPart.split(",")[0]; // take first host for replica sets
      const [host, port] = firstHost.split(":");
      if (host) result.host = host;
      if (port) result.port = port;
    }
  } catch {
    // If parsing fails, we still have the connectionString
  }

  return result;
}

const claimsMongoDB = (text: string): boolean => text.startsWith("mongodb://") || text.startsWith("mongodb+srv://");

/**
 * `mongodb`: the `mongodb://` scheme, no TLS read here, a paste of `mongodb://` or `mongodb+srv://`, no seed load
 * check.
 *
 * MongoDB's URI TLS is read by `readMongoTLS` above, which parses it by hand because `mongodb+srv://` is not a URL the
 * query-string reader's caller can build.
 */
export const MONGODB_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "mongodb",
  readTls: null,
  paste: { catchAll: false, claims: claimsMongoDB, names: claimsMongoDB, parse: parseMongoDBString },
  validateSeed: null,
};
