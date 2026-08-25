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
   * `mongodb+srv://` is set too, to `verify-system`: the driver gets the URI verbatim and
   * turns TLS on itself WITH chain verification, so that mode is a description of what
   * happens rather than an instruction. It was deliberately left UNSET while `require`
   * (rejectUnauthorized:false) was the only alternative, because the provider also sends
   * an options object the driver prefers over the URI, and that would have stopped an
   * Atlas certificate being verified. Couchbase used to be excused on the same
   * "the provider re-reads the scheme" grounds, which was simply untrue: its transport
   * is HTTP-only and derives http vs https from `config.ssl` alone.
   */
  sslMode?: SSLMode;
  /**
   * A TLS parameter the pasted string carried that SSLMode cannot express, kept verbatim
   * (`sslmode=prefer`, `ssl-mode=PREFERRED`, `Encrypt=Maybe`) so the form can say which one
   * it declined to act on.
   *
   * Two classes end up here and both must leave `sslMode` untouched rather than fall to the
   * form's "disable" default. The opportunistic values are a security decision, not a
   * translation, and the measurements make the trap concrete: against postgres 18 with no
   * server certificate `?sslmode=prefer` connects with `pg_stat_ssl.ssl = f` while
   * `?sslmode=require` is refused outright ("server does not support SSL, but SSL was
   * required"), so prefer -> require breaks a connection that works; against MySQL over TCP
   * with its default self-signed certificate `--ssl-mode=PREFERRED` negotiates
   * TLS_AES_128_GCM_SHA256 while DISABLED leaves Ssl_cipher empty, so PREFERRED -> disable
   * silently downgrades a connection that was encrypted. The second class is any spelling the
   * maps below do not know: guessing there is the same defect with less information.
   */
  unmappedTLSParam?: string;
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
 * What a TLS parameter resolved to: a mode the form can hold, or the parameter itself when
 * it has no representation. Never both, and never a fallback to "disable".
 */
interface TLSIntent {
  sslMode?: SSLMode;
  unmappedTLSParam?: string;
}

/**
 * libpq's sslmode, minus `prefer` and `allow`. Those two are absent on purpose (see the
 * `unmappedTLSParam` note): they mean "encrypt if the server offers it", which no SSLMode
 * value describes. `verify-system` is not in the table either - it is this form's own mode
 * name and not a libpq one, so a string carrying it is a string we cannot honour.
 */
const POSTGRES_SSLMODE: Record<string, SSLMode> = {
  disable: "disable",
  require: "require",
  "verify-ca": "verify-ca",
  "verify-full": "verify-full",
};

/**
 * MySQL's --ssl-mode, minus PREFERRED for the same reason. VERIFY_IDENTITY checks the
 * hostname as well as the chain, which is what verify-full means here.
 */
const MYSQL_SSL_MODE: Record<string, SSLMode> = {
  disabled: "disable",
  required: "require",
  verify_ca: "verify-ca",
  verify_identity: "verify-full",
};

/**
 * One query parameter kept in the spelling it was pasted in. The lookup is
 * case-insensitive, but the banner quotes the parameter back at the user, so what it echoes
 * has to be their text and not a normalised form of it.
 */
interface RawParam {
  name: string;
  value: string;
}

/**
 * Map a documented value case-insensitively, or hand back the parameter verbatim.
 *
 * `Object.hasOwn` rather than a bare lookup: the tables are object literals, so an
 * all-lowercase Object.prototype key reaches them. `?sslmode=constructor` resolved to the
 * Object constructor FUNCTION - truthy, so it was written into `sslMode` and set as the
 * form's SSLMode, smuggling a non-SSLMode value past the banner this function exists to
 * raise. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 */
function mapTLSValue(param: RawParam, table: Record<string, SSLMode>): TLSIntent {
  const key = param.value.toLowerCase();
  return Object.hasOwn(table, key) ? { sslMode: table[key] } : { unmappedTLSParam: `${param.name}=${param.value}` };
}

/**
 * The boolean TLS spellings: postgres's JDBC/Heroku `ssl=true`, MySQL's `ssl` / `useSSL`
 * (Connector/J's pre-`sslMode` switch, still written by several ORMs) and MongoDB's `tls` /
 * `ssl`. A boolean has no opportunistic value, so unlike `sslmode`/`ssl-mode` both ends of it
 * are mappable.
 *
 * THE RULE (D26): a boolean TLS spelling is mapped onto the mode that matches what the
 * engine's OWN driver does with it, and never onto a weaker one. `true` therefore maps to
 * `verify-system`, because that is what the drivers do: `pg` given `ssl=true` and mysql2 given
 * `ssl: {}` both connect with Node's default `rejectUnauthorized: true`, and the mongodb
 * driver reads `tls=true` as TLS with chain verification. `false` maps to `disable`, which is
 * the same rule read the other way.
 *
 * `require` used to be the answer for `true`, and was wrong in one direction while the mongodb
 * refusal was wrong in the other: `require` is `rejectUnauthorized: false` in every provider
 * that has the knob, so a paste that asked for a verified connection got an unverified one,
 * and there was no mode to map onto that did not also demand a CA PEM the user does not have.
 * `verify-system` (src/lib/types.ts) is that mode, so the rule above no longer has to trade
 * security against completability.
 */
function readBooleanTLS(param: RawParam): TLSIntent {
  const flag = param.value.toLowerCase();
  if (flag === "true" || flag === "1") return { sslMode: "verify-system" };
  if (flag === "false" || flag === "0") return { sslMode: "disable" };
  return { unmappedTLSParam: `${param.name}=${param.value}` };
}

/**
 * The MongoDB URI's TLS options, read for both schemes.
 *
 * `tls=true` (and the driver's deprecated `ssl=` alias) goes through the boolean rule above,
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
  return relax !== undefined && relax.value.toLowerCase() === "true" ? { sslMode: "require" } : intent;
}

/**
 * ADO.NET's Encrypt/TrustServerCertificate pair, from either the keyword string or an
 * mssql:// query. Encrypt on with TrustServerCertificate on is `require`: encrypted, chain
 * unchecked. Encrypt on with it off - including absent, which is the documented default -
 * validates the chain AND the name, so verify-full. `Strict` is TDS 8.0, where the driver
 * ignores TrustServerCertificate entirely and always validates.
 *
 * An absent Encrypt says nothing rather than "disable": System.Data.SqlClient defaults it to
 * false and Microsoft.Data.SqlClient 4.0+ to true, so the string alone does not carry the answer.
 */
function readADONetTLS(get: (key: string) => string | undefined): TLSIntent {
  const encrypt = get("encrypt");
  if (encrypt === undefined) return {};
  const value = encrypt.toLowerCase();
  if (value === "false" || value === "no") return { sslMode: "disable" };
  if (value === "strict") return { sslMode: "verify-full" };
  if (value !== "true" && value !== "yes") return { unmappedTLSParam: `Encrypt=${encrypt}` };

  const trust = get("trustservercertificate");
  if (trust === undefined) return { sslMode: "verify-full" };
  const trusted = trust.toLowerCase();
  if (trusted === "true" || trusted === "yes") return { sslMode: "require" };
  if (trusted === "false" || trusted === "no") return { sslMode: "verify-full" };
  return { unmappedTLSParam: `TrustServerCertificate=${trust}` };
}

/**
 * The TLS a URL carries in its QUERY STRING, for the engines that put it there.
 *
 * Only postgres, mysql and mssql are read here: for `rediss://`, `couchbases://` and
 * ClickHouse's `http(s)://` the scheme IS the transport and already decided, and MongoDB's
 * URI is read by `readMongoTLS`, which parses it by hand because `mongodb+srv://` is not a
 * URL this function's caller can build.
 *
 * Postgres's sslrootcert/sslcert/sslkey are read by nobody here on purpose: they name files on
 * the machine that wrote the string, while the form holds PEM text and the process that opens
 * the connection is the server, which cannot read that path.
 */
function readQueryTLS(url: URL, type: DatabaseType): TLSIntent {
  const params = new Map<string, RawParam>();
  for (const [name, value] of url.searchParams) params.set(name.toLowerCase(), { name, value });

  if (type === "postgres") {
    // The explicit mode wins over the boolean: a string carrying both said the specific
    // thing on purpose.
    const sslmode = params.get("sslmode");
    if (sslmode) return mapTLSValue(sslmode, POSTGRES_SSLMODE);
    const ssl = params.get("ssl");
    return ssl ? readBooleanTLS(ssl) : {};
  }

  if (type === "mysql") {
    const mode = params.get("ssl-mode") ?? params.get("sslmode");
    if (mode) return mapTLSValue(mode, MYSQL_SSL_MODE);
    // Reading only ssl-mode dropped `?ssl=true` and `?useSSL=true` with no mode and no
    // banner - the silent downgrade the whole TLS read exists to prevent. mysql2 also
    // accepts an OBJECT here (`ssl={"rejectUnauthorized":true}`); that is not a boolean, so
    // it falls through to the banner rather than being guessed at.
    const flag = params.get("ssl") ?? params.get("usessl");
    return flag ? readBooleanTLS(flag) : {};
  }

  if (type === "mssql") return readADONetTLS((key) => params.get(key)?.value);

  return {};
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
    ...readMongoTLS(uri),
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
      ...readADONetTLS((key) => params[key]),
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
      ...readQueryTLS(url, type),
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
