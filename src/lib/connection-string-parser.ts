import { DatabaseType, type SSLMode } from "@/lib/types";

export interface ParsedConnection {
  type: DatabaseType;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
  /**
   * TLS the scheme asked for, when the fields alone could not express it.
   *
   * Set by every scheme that IS the transport - `https://` for ClickHouse,
   * `rediss://`, `couchbases://` - and by their plaintext twins, because a paste
   * overwrites rather than merges. Dropping it leaves the form on its "disable"
   * default and the provider then speaks plaintext to a TLS port, which fails with a
   * bare "fetch failed" / "Connection is closed." and nothing pointing at the scheme.
   *
   * `mongodb+srv://` is the one secure scheme deliberately left unset: the driver gets
   * the URI verbatim and turns TLS on itself, WITH chain verification, so handing it
   * our `require` (rejectUnauthorized:false, see the mode note below) would stop an
   * Atlas certificate being verified. Couchbase used to be excused on the same
   * "the provider re-reads the scheme" grounds, which was simply untrue: its transport
   * is HTTP-only and derives http vs https from `config.ssl` alone.
   */
  sslMode?: SSLMode;
}

/**
 * The canonical URI scheme each engine is reachable by, for the engines that HAVE one.
 *
 * Deliberately partial, and the gaps are the point: SQLite is a file path, LibreDB is
 * embedded in the process, and Druid is reached over plain HTTP through the form. Inventing
 * `sqlite://` or `druid://` to make the map look complete would put a scheme on the login
 * page that `parseConnectionString` below rejects - a claim the product does not honour,
 * which is the class of defect issue #425 exists to remove.
 *
 * Cassandra is absent for a different reason again, and a stronger one: its driver needs
 * a REQUIRED `localDataCenter` alongside the contact points (measured on 4.9.0 - it
 * refuses to construct a client without one), and no URI convention in use carries that
 * field. A `cassandra://host:9042/keyspace` form would therefore parse into a connection
 * that cannot open, which is worse than no paste at all.
 *
 * Trino is the sharpest version of that gap, and worth naming because it looks like it
 * belongs here: it HAS a canonical URL, `jdbc:trino://host:port/catalog/schema`. That is
 * a JDBC URL and not a URI - `new URL()` reads its scheme as `jdbc:` - and stripping the
 * prefix to make one would invent a `trino://` form no Trino tool emits. So the id is
 * absent, its capabilities say `supportsConnectionString: false`, and its form offers no
 * paste toggle. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 *
 * Aliases the parser also accepts (`postgresql://`, `mongodb+srv://`, `rediss://`,
 * `sqlserver://`, `couchbases://`, and ClickHouse's `http(s)://`) are not listed: this map
 * answers "what is the one scheme to show a reader for this engine", not "what will parse".
 *
 * `tests/unit/lib/connection-string-parser.test.ts` pins the entries against the parser
 * itself - every scheme here must round-trip to its own `DatabaseType` - so the map cannot
 * drift away from the `startsWith` checks below without failing CI.
 */
export const ENGINE_URI_SCHEMES: Partial<Record<DatabaseType, string>> = {
  postgres: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  redis: "redis",
  oracle: "oracle",
  mssql: "mssql",
  couchbase: "couchbase",
  clickhouse: "clickhouse",
};

/**
 * Parse a database connection string URL into its components.
 * Supports: postgres://, postgresql://, mysql://, mongodb://, mongodb+srv://, redis://,
 * couchbase://, couchbases://, clickhouse://, http://, https://
 */
export function parseConnectionString(input: string): ParsedConnection | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // MongoDB connection strings
  if (trimmed.startsWith("mongodb://") || trimmed.startsWith("mongodb+srv://")) {
    return parseMongoDBString(trimmed);
  }

  // PostgreSQL
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return parseGenericURL(trimmed, "postgres", "5432");
  }

  // MySQL
  if (trimmed.startsWith("mysql://")) {
    return parseGenericURL(trimmed, "mysql", "3306");
  }

  // Redis - `rediss://` IS TLS (the secure form in Redis's own URI convention,
  // the one `redis-cli --tls` and every client library reads that way) and ioredis only
  // negotiates it when a `tls` option is present, which the provider builds from
  // `config.ssl` alone. `require` rather than a verifying mode: it maps to
  // `rejectUnauthorized: false`, and a self-hosted Redis presents a self-signed
  // certificate by default, so a verifying mode would refuse the ordinary
  // `--tls-port` deployment. A paste therefore encrypts but never silently claims to
  // have checked a chain; the panel is where verification is chosen. The plain scheme
  // is the explicit plaintext twin, so it clears a mode the form is still holding.
  if (trimmed.startsWith("rediss://")) {
    return withSSLMode(parseGenericURL(trimmed, "redis", "6379"), "require");
  }
  if (trimmed.startsWith("redis://")) {
    return withSSLMode(parseGenericURL(trimmed, "redis", "6379"), "disable");
  }

  // Oracle
  if (trimmed.startsWith("oracle://")) {
    return parseGenericURL(trimmed, "oracle", "1521");
  }

  // MSSQL / SQL Server
  if (trimmed.startsWith("mssql://") || trimmed.startsWith("sqlserver://")) {
    return parseGenericURL(trimmed, "mssql", "1433");
  }

  // Couchbase — the TLS scheme is checked first, it is not a prefix of the plain one.
  // The mode travels for the same reason as ClickHouse's: this provider talks HTTP,
  // and `CouchbaseHttpTransport` picks `https` vs `http` from `config.ssl`, never from
  // the pasted string it also stores. Without the mode a `couchbases://` paste posts
  // plain HTTP to 18091. `require` for the same reason as Redis: Capella's certificate
  // is CA-signed, a self-hosted cluster's is not, and only the panel should turn
  // verification on.
  if (trimmed.startsWith("couchbases://")) {
    return withSSLMode(parseCouchbaseString(trimmed, "18091"), "require");
  }
  if (trimmed.startsWith("couchbase://")) {
    return withSSLMode(parseCouchbaseString(trimmed, "8091"), "disable");
  }

  // ClickHouse — the HTTP endpoint IS the connection target, so a bare http(s) URL is
  // as canonical as the clickhouse:// scheme and no other provider claims those
  // schemes. 8123 rather than 9000 because the provider speaks HTTP, never the native
  // protocol the CLI's clickhouse:// URIs point at; https:// defaults to the server's
  // https_port instead. The result is field-based (no connectionString), so the pasted
  // URL never has to be re-parsed at connect time.
  // The three schemes differ in what they say about TLS, and each has to be able to
  // OVERWRITE a mode the form already carries - pasting is not a merge:
  //   clickhouse:// names no transport  -> say nothing, defer to the form
  //   http://       explicitly plaintext -> disable, or a stale "require" survives
  //   https://      explicitly TLS       -> require, or a Cloud endpoint gets plain HTTP
  if (trimmed.startsWith("clickhouse://")) {
    return parseGenericURL(trimmed, "clickhouse", "8123");
  }
  if (trimmed.startsWith("http://")) {
    return withSSLMode(parseGenericURL(trimmed, "clickhouse", "8123"), "disable");
  }
  if (trimmed.startsWith("https://")) {
    return withSSLMode(parseGenericURL(trimmed, "clickhouse", "8443"), "require");
  }

  // ADO.NET format: Server=host;Database=db;User Id=user;Password=pass;
  if (/^Server\s*=/i.test(trimmed)) {
    return parseADONetString(trimmed);
  }

  return null;
}

/**
 * Attach a scheme's TLS intent, preserving the null a malformed URL parses to.
 */
function withSSLMode(parsed: ParsedConnection | null, sslMode: SSLMode): ParsedConnection | null {
  return parsed && { ...parsed, sslMode };
}

function parseMongoDBString(uri: string): ParsedConnection {
  const result: ParsedConnection = {
    type: "mongodb",
    connectionString: uri,
  };

  try {
    // For mongodb+srv, we can't use URL directly for host/port
    // but we can extract user/pass/database
    const isSRV = uri.startsWith("mongodb+srv://");

    // Extract database from path
    const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//, "");
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

/**
 * Percent-decode a component, keeping it verbatim when it is not a valid escape
 * sequence. Couchbase bucket names may legally contain a literal "%".
 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a Couchbase connection string. Only the management port is stored — 8091 for
 * couchbase://, 18091 for couchbases:// — because the query ports are discovered from the
 * cluster at connect time. A Capella endpoint (couchbases://cb.<id>.cloud.couchbase.com)
 * carries neither a port nor a bucket path, so both stay at their defaults and no bucket
 * is invented. The full original string is always preserved.
 */
function parseCouchbaseString(uri: string, defaultPort: string): ParsedConnection | null {
  try {
    const url = new URL(uri);
    // Multi-node connection strings list hosts comma-separated; take the first one.
    const [firstHost] = url.hostname.split(",");
    const bucket = url.pathname.slice(1); // remove leading /

    return {
      type: "couchbase",
      host: firstHost || "localhost",
      port: url.port || defaultPort,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: bucket ? safeDecodeURIComponent(bucket) : undefined,
      connectionString: uri,
    };
  } catch {
    return null;
  }
}

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
    const [hostPart, portPart] = host.split(",");

    return {
      type: "mssql",
      host: hostPart || "localhost",
      port: portPart || "1433",
      user: params["user id"] || params["uid"] || undefined,
      password: params["password"] || params["pwd"] || undefined,
      database: params["database"] || params["initial catalog"] || undefined,
    };
  } catch {
    return null;
  }
}

function parseGenericURL(uri: string, type: DatabaseType, defaultPort: string): ParsedConnection | null {
  try {
    const url = new URL(uri);

    return {
      type,
      host: url.hostname || "localhost",
      port: url.port || defaultPort,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: url.pathname.slice(1) || undefined, // remove leading /
    };
  } catch {
    return null;
  }
}

/**
 * Detect the database type from a connection string.
 */
export function detectConnectionStringType(input: string): DatabaseType | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) return "postgres";
  if (trimmed.startsWith("mysql://")) return "mysql";
  if (trimmed.startsWith("mongodb://") || trimmed.startsWith("mongodb+srv://")) return "mongodb";
  if (trimmed.startsWith("redis://") || trimmed.startsWith("rediss://")) return "redis";
  if (trimmed.startsWith("oracle://")) return "oracle";
  if (trimmed.startsWith("mssql://") || trimmed.startsWith("sqlserver://")) return "mssql";
  if (trimmed.startsWith("couchbase://") || trimmed.startsWith("couchbases://")) return "couchbase";
  if (trimmed.startsWith("clickhouse://") || trimmed.startsWith("http://") || trimmed.startsWith("https://"))
    return "clickhouse";
  if (/^server\s*=/i.test(trimmed)) return "mssql";
  return null;
}
