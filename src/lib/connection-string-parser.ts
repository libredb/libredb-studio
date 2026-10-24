import { connectionStringFor } from "@/lib/db/connection-string";
import { readADONetTLS, readBooleanTLS } from "@/lib/db/connection-string/shared";
import type { RawParam, TLSIntent } from "@/lib/db/connection-string/types";
import { databendCloudHostWarehouse } from "@/lib/db/providers/sql/databend/cloud-host";
import {
  isAccountIdentifier,
  isSnowflakeHost,
  readSnowflakeAccount,
  SNOWFLAKE_FIELD_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { parseSparkConnectUri } from "@/lib/db/providers/sql/spark/sc-uri";
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
  /**
   * A MongoDB TLS parameter naming a file path (`tlsCAFile`, the only one reported so far,
   * #842) rather than a value SSLMode could express, kept verbatim for the same reason
   * `unmappedTLSParam` is.
   *
   * The driver reads this as a path on the machine running the server process, which in a
   * container is not the machine the string was pasted on (measured: mongodb 7.6.0's
   * `fs.readFile` throws ENOENT before any network traffic when the file is absent there).
   * The parameter stays in the URI, and the form already has a place for the certificate's
   * contents - the CA box under SSL / TLS, `ssl.caCert` in the connection config - which
   * wins over it: the driver loads the file only when no `ca` option is set (`options.ca ??=`
   * in mongo_client.js), so the fix is to point the user there. Kept separate from
   * `unmappedTLSParam`: that field is documented around SSLMode's own value space, and a
   * file path is not a value SSLMode could ever express.
   */
  tlsFileParam?: string;
  /**
   * Set when a pasted MongoDB URI's credentials segment has more than one unescaped `@`,
   * which makes the auth/host split ambiguous: `mongodb://user:p@ss@host/db` reads as
   * password `p`, host `ss` (#842) instead of refusing. A properly percent-encoded password
   * (`p%40ss`) never sets this - the encoded form has exactly one literal `@`.
   *
   * `user`, `password` and `host` are left unset rather than populated with the wrong
   * guess; `connectionString` still carries the pasted URI with its scheme lower-cased
   * and everything after `://` unchanged (#1916).
   */
  credentialsAmbiguous?: boolean;
  /**
   * The SqlClient protocol prefix of an ADO.NET `Server` that tedious cannot speak, kept as
   * it was pasted (`np` for named pipes, `lpc` for shared memory). tedious reaches SQL
   * Server over TCP only (#1211), so `host` and `port` are left unset rather than filled
   * with `np:myserver`, which would only fail later as a misleading `ENOTFOUND`.
   */
  unsupportedServerProtocol?: string;
  /**
   * The warehouse statements run on, for the form's Warehouse box: Databend's `warehouse=` (design 6.2), which
   * Databend Cloud requires, or Snowflake's `warehouse=`, optional, the user's default warehouse when absent.
   */
  warehouse?: string;
  /** Snowflake's `schema=` or SQLAlchemy path schema, for the form's Schema box. */
  schema?: string;
  /** Snowflake's `role=`, the role every statement runs as. */
  role?: string;
  /** Snowflake's sign-in, from `authenticator=` (`SNOWFLAKE_JWT` or `PROGRAMMATIC_ACCESS_TOKEN`) or a `token=`. */
  authMethod?: "keypair" | "pat";
  /** Snowflake's private key passphrase, from `private_key_pwd`, `private_key_file_pwd` or `private_key_passphrase`. */
  privateKeyPassphrase?: string;
  /**
   * The consent to send the password without TLS that the paste carries, for the form's box of that name. A Databend
   * DSN has no parameter that gives it, so a Databend paste answers `false`, and the form clears a consent an earlier
   * connection or paste left ticked rather than send the password in cleartext to a host nobody consented for. Absent
   * for every other scheme, whose paste leaves the box as it was: Db2's form shares it.
   */
  allowInsecureAuth?: boolean;
  /**
   * The names of the query parameters the paste did not apply, each once, in the order pasted. Names only: a
   * parameter's value can be a secret, so it never leaves the parser.
   */
  ignoredParameters?: string[];
  /**
   * How many other query parameters the paste did not apply, counted and never named: a parameter that is not one of
   * the driver's own names, or a text with no `name=`, can be the rest of a value an unencoded `&` split off.
   */
  unnamedParameters?: number;
  /**
   * Why the paste was refused as a whole, in the sentence the form shows. When set, nothing but `type` and
   * `discardPaste` is, and the form applies nothing, its type included unless `discardPaste` is set.
   */
  refusal?: string;
  /**
   * Set with a refusal whose text may hold a secret, a Snowflake token or key among them: the form clears the paste
   * box rather than keep the text there to be corrected, and switches to `type`, filling nothing, so the box the
   * sentence names is in view.
   */
  discardPaste?: true;
  /**
   * A sentence the form shows beside a successful paste, for a parameter that was applied with a meaning the field
   * alone does not show. An Apache Spark `sc://` paste also writes its not-applied sentence here, and sets neither
   * `ignoredParameters` nor `unnamedParameters`, which the form shows in a sentence that names Databend.
   */
  notice?: string;
  /**
   * Sentences the form shows as a warning beside a paste that filled the other fields, each for a TLS parameter the
   * paste read and did not apply, in the scheme's own words, since the form's own TLS sentences describe its modes and
   * not the scheme's.
   */
  cautions?: string[];
}

/**
 * The canonical URI scheme each engine is reachable by, for the engines that HAVE one. Derived inside the connection
 * string registry (src/lib/db/connection-string), where the reasons each gap is deliberate live, and re-exported here
 * so the login signature and the parser tests keep one import.
 */
export { ENGINE_URI_SCHEMES } from "@/lib/db/connection-string";

/**
 * The sentences a refused Databend paste shows (design 6.2), one per refusal. Each refusal fills no field, so the
 * sentence says what to paste instead.
 */
export const DATABEND_DSN_REFUSALS = Object.freeze({
  fragment: "The DSN contains #, which ends a URL: percent-encode it as %23, or type the password in its own field.",
  userinfo:
    "The DSN has an @ after a / or ?, which end the address part of a URL: percent-encode a /, ? or @ in the user or password as %2F, %3F or %40, or type the password in its own field, and an @ in the path or a parameter as %40.",
  signIn:
    "Token and key-pair sign-in are not supported in this version: paste a DSN that signs in with a SQL user and password, or fill the fields.",
  flight: "Flight SQL (port 8900) is not supported: paste the HTTP DSN, databend://, for port 8000 or 443.",
  jdbc: "This is a JDBC URL, which reads TLS and ports differently (TLS off and port 8000 by default). Paste the databend:// DSN from Connect, or fill the fields.",
  shellExport: "Paste the DSN itself: the databend:// text inside the quotes.",
});

/**
 * What a Databend DSN's `sslmode=require` and `sslmode=enable` mean (X34): BendSQL connects over https with the
 * certificate verified, which is this form's verify-system and not its unverified require.
 */
export const DATABEND_SSLMODE_NOTICES = Object.freeze({
  require: "sslmode=require in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system.",
  enable: "sslmode=enable in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system.",
});

/**
 * The cautions of a Databend paste (`cautions`), for the TLS parameters it reads and does not apply: a CA file path,
 * which only the machine running BendSQL could read, and an sslmode BendSQL does not read, which the form's own TLS
 * sentence would list among the modes it says the parameter has no equivalent in.
 */
export const DATABEND_DSN_CAUTIONS = Object.freeze({
  caFile:
    "Studio reads no CA file path from a DSN, so tls_ca_file was not applied: paste the certificate's contents into the CA field under SSL / TLS.",
  sslmode: (mode: string) =>
    `sslmode=${mode} is not a Databend DSN mode (BendSQL reads disable, require and enable), so SSL mode was left as it was: choose one under SSL / TLS.`,
});

/**
 * The warning a Databend paste shows for the parameters it did not apply: BendSQL's own names, never valued, and a
 * count of the rest, which are never named.
 */
export function databendNotAppliedNotice(names: readonly string[], unnamed = 0): string {
  const counted = `${unnamed} ${names.length > 0 ? "other " : ""}parameter${unnamed === 1 ? "" : "s"}`;
  const listed = [names.join(", "), unnamed > 0 ? counted : ""].filter(Boolean).join(" and ");
  return `Not applied: ${listed}. Studio's Databend connection takes host, port, user, password, database, warehouse and TLS; the other fields were filled in.`;
}

/** The sentences of a Snowflake paste: two refusals, each naming the parameter in this list's own spelling. */
export const SNOWFLAKE_PASTE_SENTENCES = Object.freeze({
  inlineKey: (name: string) =>
    `Studio does not take ${name} from a pasted URL. Paste the key itself into Private key, not inside a URL.`,
  path: (name: string) =>
    `Studio does not take ${name} from a pasted URL. Studio reads no file: paste the key's contents into Private key.`,
  tls: "Studio checks TLS whatever insecureMode or disableOCSPChecks say.",
  foreignHost:
    "This URL names a host outside Snowflake. A jdbc:snowflake:// URL carries the account's host, ending in .snowflakecomputing.com or .snowflakecomputing.cn, and a snowflake:// URL that host or the account identifier, such as myorg-myaccount. Nothing was applied.",
});

/**
 * URI schemes ignore case (RFC 3986 6.2.2.1; #1916); every character after `://` keeps its case.
 * The JDBC wrapper is read with its inner scheme too, while text that is not a URI - a shell
 * export, an ADO.NET password with `://` inside - is returned exactly as typed.
 */
function normalizedScheme(input: string): string {
  const schemeEnd = input.indexOf("://");
  if (schemeEnd === -1) return input;
  const prefix = input.slice(0, schemeEnd);
  if (!/^(?:jdbc:)?[a-z][a-z0-9+.-]*$/i.test(prefix)) return input;
  return prefix.toLowerCase() + input.slice(schemeEnd);
}

/**
 * Parse a database connection string into its components, or null when no form below reads it.
 * Schemes, matched case-insensitively on the trimmed input: postgres://, postgresql://, mysql://,
 * mongodb://, mongodb+srv://, rediss://, redis://, oracle://, mssql://, sqlserver://, db2://,
 * couchbases://, couchbase://, libsql://, clickhouse://, and http:// and https:// (both ClickHouse),
 * databend://, databend+http:// and databend+https://, plus the ADO.NET form `Server=...;` (SQL Server), whose
 * `Server=` key is matched case-insensitively. Databend's other spellings (`databend+flight://`, `databend+grpc://`,
 * `jdbc:databend://` and a `BENDSQL_DSN=` shell line) parse to a refusal.
 * Apache Spark's `sc://` address is read by `parseSparkConnectUri`, and its `jdbc:sc://` form parses to a refusal.
 */
export function parseConnectionString(input: string): ParsedConnection | null {
  const trimmed = normalizedScheme(input.trim());
  if (!trimmed) return null;

  // Databend (design 6.2). The refusals first: each names a Databend spelling Studio does not connect with.
  if (/^(export\s+)?BENDSQL_DSN=/.test(trimmed)) return databendRefusal("shellExport");
  if (trimmed.startsWith("jdbc:databend://")) return databendRefusal("jdbc");
  if (trimmed.startsWith("databend+flight://") || trimmed.startsWith("databend+grpc://")) {
    return databendRefusal("flight");
  }
  if (/^databend(\+https?)?:\/\//.test(trimmed)) return parseDatabendDSN(trimmed);

  // Apache Spark: the sc:// address, and the Spark Connect JDBC driver's jdbc:sc:// form, which it refuses.
  if (trimmed.startsWith("sc://") || trimmed.startsWith("jdbc:sc://")) return parseSparkConnectUri(trimmed);

  // Snowflake, ahead of ClickHouse's https:// rule: only an exact Snowflake host or Snowsight is claimed.
  if (isSnowflakePaste(trimmed)) return parseSnowflakeURL(trimmed);

  // MongoDB connection strings
  if (trimmed.startsWith("mongodb://") || trimmed.startsWith("mongodb+srv://")) {
    return parseMongoDBString(trimmed);
  }

  // PostgreSQL
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return parsePostgresURL(trimmed);
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

  // Db2 LUW (#786). The TLS it asks for rides in the query string, read by `readQueryTLS`.
  if (trimmed.startsWith("db2://")) {
    return parseGenericURL(trimmed, "db2", "50000");
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
  // libSQL. TLS always, and the token rides in the query string rather than in the
  // authority: `libsql://<database>-<org>.turso.io?authToken=<jwt>` is what Turso's
  // own CLI prints, and `libsql://` has no plaintext form - a self-hosted server on
  // plain HTTP is reached through the host/port fields with TLS off, because
  // `http://` already resolves to ClickHouse here and two engines cannot own one
  // scheme.
  if (trimmed.startsWith("libsql://")) {
    return parseLibSQLURL(trimmed);
  }

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

/**
 * The TLS a URL carries in its QUERY STRING, for the engines that put it there.
 *
 * Each engine's reader is the `readTls` of its row in `CONNECTION_STRING`
 * (src/lib/db/connection-string), declared beside its provider; postgres, mysql, mssql and db2
 * have one. For `rediss://`, `couchbases://` and ClickHouse's `http(s)://` the scheme IS the
 * transport and already decided, and MongoDB's URI is read by `readMongoTLS`, which parses it
 * by hand because `mongodb+srv://` is not a URL this function's caller can build.
 */
function readQueryTLS(url: URL, type: DatabaseType): TLSIntent {
  const params = new Map<string, RawParam>();
  for (const [name, value] of url.searchParams) params.set(name.toLowerCase(), { name, value });
  const read = connectionStringFor(type).readTls;
  return read === null ? {} : read(params);
}

/**
 * Attach a scheme's TLS intent, preserving the null a malformed URL parses to. The mode
 * overwrites whatever the form was holding - pasting is not a merge.
 *
 * A scheme is read more weakly than the boolean *parameter* beside it, and that is a
 * decision rather than an artefact (D28). D26 settled the rule for a boolean parameter:
 * it maps onto the mode matching what the engine's own driver does with it, never onto a
 * weaker one. A scheme cannot answer to that rule, because the secure scheme is the only
 * spelling a self-hosted deployment has: `rediss://`, `couchbases://` and ClickHouse's
 * `https://` all describe servers that present a self-signed certificate by default, so
 * a verifying mode here would refuse the ordinary `--tls-port` install with a chain
 * error. `require` therefore encrypts without ever claiming to have checked a chain, and
 * the connection panel stays the one place verification is turned on. The per-scheme
 * reason is recorded at each call site above; this is the rule they share.
 */
function withSSLMode(parsed: ParsedConnection | null, sslMode: SSLMode): ParsedConnection | null {
  return parsed && { ...parsed, sslMode };
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

/**
 * Percent-decode a component, keeping it verbatim when it is not a valid escape
 * sequence. Couchbase bucket names may legally contain a literal "%".
 */
export function safeDecodeURIComponent(value: string): string {
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
 * is invented. The pasted string is preserved up to the scheme's case (#1916).
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

/**
 * A `libsql://` URL as a connection.
 *
 * Three things differ from `parseGenericURL` and each is measured against what Turso
 * emits: the credential is `?authToken=`, so the URL's own password slot is only a
 * fallback; there is no database in the path, because the database IS the hostname;
 * and the default port is 443 under required TLS, which is how Turso Cloud serves
 * every database.
 */
function parseLibSQLURL(uri: string): ParsedConnection | null {
  try {
    const url = new URL(uri);

    return {
      type: "libsql",
      host: url.hostname || "localhost",
      port: url.port || "443",
      password: url.searchParams.get("authToken") ?? (url.password ? decodeURIComponent(url.password) : undefined),
      sslMode: "require",
    };
  } catch {
    return null;
  }
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
 * the URL, the way the rest of this parser treats them.
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
  const parsed = parseGenericURL(normalized, "postgres", "5432");
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

function parseGenericURL(uri: string, type: DatabaseType, defaultPort: string): ParsedConnection | null {
  try {
    const url = new URL(uri);

    return {
      type,
      host: url.hostname || "localhost",
      port: url.port || defaultPort,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      // The pathname keeps a space, non-ASCII letter or reserved character percent-encoded.
      // Decode it the way the user, the password and the MongoDB database already are, and
      // keep a broken escape as written. An empty path is no database.
      database: url.pathname.length > 1 ? safeDecodeURIComponent(url.pathname.slice(1)) : undefined,
      ...readQueryTLS(url, type),
    };
  } catch {
    return null;
  }
}

function databendRefusal(key: keyof typeof DATABEND_DSN_REFUSALS): ParsedConnection {
  return { type: "databend", refusal: DATABEND_DSN_REFUSALS[key] };
}

/** The DSN parameters a paste reads, each into a field or a caution; every other name is reported as not applied. */
const DATABEND_APPLIED_PARAMETERS = new Set(["warehouse", "sslmode", "tls_ca_file"]);

/**
 * The other parameters BendSQL reads by name (`core/src/client.rs`, `from_dsn`), which a paste names when it does not
 * apply them. BendSQL sends any other name as a session setting; a paste counts those and never names them, since an
 * unencoded `&` inside a value makes the rest of the value read as a name.
 */
const DATABEND_NAMED_PARAMETERS = new Set([
  "wait_time_secs",
  "max_rows_in_buffer",
  "max_rows_per_page",
  "connect_timeout",
  "page_request_timeout_secs",
  "presign",
  "tenant",
  "role",
  "login",
  "session_token",
  "body_format",
  "query_result_format",
  "retry_count",
  "retry_delay_secs",
]);

/**
 * The query parameters a Databend paste did not apply: BendSQL's own names, each once in the order pasted, and how
 * many others there are. A text with no `=` is counted even when it spells a name, since it can be a value's tail.
 */
function databendIgnoredParameters(search: string): { names: string[]; unnamed: number } {
  const names = new Set<string>();
  const unnamed = new Set<string>();
  for (const pair of search.slice(1).split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    if (equals < 0) {
      unnamed.add(pair);
      continue;
    }
    const name = [...new URLSearchParams(pair).keys()][0];
    if (DATABEND_APPLIED_PARAMETERS.has(name)) continue;
    if (DATABEND_NAMED_PARAMETERS.has(name)) names.add(name);
    else unnamed.add(name);
  }
  return { names: [...names], unnamed: unnamed.size };
}

/** The `sslmode` values BendSQL reads; any other refuses the DSN there. */
const DATABEND_SSLMODES = new Set(["disable", "require", "enable"]);

/** BendSQL's sign-in parameters other than a password, which this version does not support. */
const DATABEND_SIGN_IN_PARAMETERS = new Set([
  "access_token",
  "access_token_file",
  "private_key_file",
  "private_key_passphrase_file",
]);

/**
 * A Databend DSN, read the way BendSQL reads it (`core/src/client.rs`, `from_dsn`): TLS unless `sslmode=disable`,
 * where `require` and `enable` verify the certificate; the DSN's port, else 443 with TLS and 80 without; the path is
 * the database and `warehouse=` the warehouse. `databend+http://` and `databend+https://` set the transport as
 * databend-go reads them, and an explicit `sslmode` wins over either; one BendSQL does not read leaves SSL mode as it
 * was, with a caution, and the port the scheme's. A repeated parameter takes its last value, as BendSQL's does
 * (databend-go takes the first).
 *
 * Three departures, each refusing rather than guessing: a `#` ends a URL, so a password holding one would be cut short;
 * a `/` or `?` ends the address part, so with one in the user or the password the URL parser reads the rest of the
 * password as the database or a parameter, and since an `@` past the address part can also be a path's or a
 * parameter's, and a password can hold an unencoded `@` before its `/`, every such `@` is refused, naming each
 * encoding; and BendSQL's token and key-pair sign-in have no field here. Unlike BendSQL, which decodes the password
 * only, the user and the database path are percent-decoded too, as every other scheme here does. With no
 * `warehouse=`, the warehouse an older Databend Cloud host names (`<tenant>--<warehouse>.gw...`) fills Warehouse.
 */
function parseDatabendDSN(uri: string): ParsedConnection | null {
  if (uri.includes("#")) return databendRefusal("fragment");
  // An @ past the address part reads more than one way: the sign-in's own, after a / or ? in the user or password; a
  // later @ of a password that also holds one, as `root:p@ss/x@host` does; or an unencoded @ of the path or a
  // parameter. An @ inside the address part settles none of them, so every such text is refused.
  const address = uri.slice(uri.indexOf("://") + 3);
  const addressEnd = address.search(/[/?]/);
  if (addressEnd >= 0 && address.includes("@", addressEnd)) return databendRefusal("userinfo");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  const names = [...new Set(url.searchParams.keys())];
  if (names.some((name) => DATABEND_SIGN_IN_PARAMETERS.has(name))) return databendRefusal("signIn");

  // A repeated parameter takes its last value, as BendSQL's loop over the pairs overwrites, and an sslmode it
  // cannot read refuses the DSN wherever it stands.
  const sslmodes = url.searchParams.getAll("sslmode");
  const sslmode = sslmodes.find((mode) => !DATABEND_SSLMODES.has(mode)) ?? sslmodes.at(-1) ?? null;
  const plainScheme = uri.startsWith("databend+http://");
  let tls: TLSIntent = { sslMode: plainScheme ? "disable" : "verify-system" };
  let notice: string | undefined;
  const cautions: string[] = [];
  if (sslmode === "disable") tls = { sslMode: "disable" };
  else if (sslmode === "require" || sslmode === "enable") {
    tls = { sslMode: "verify-system" };
    notice = DATABEND_SSLMODE_NOTICES[sslmode];
  } else if (sslmode !== null) {
    tls = {};
    cautions.push(DATABEND_DSN_CAUTIONS.sslmode(sslmode));
  }
  // BendSQL reads the CA file on its own machine; Studio reads no path, and its CA box takes the certificate itself.
  if (url.searchParams.has("tls_ca_file")) cautions.push(DATABEND_DSN_CAUTIONS.caFile);

  const warehouse = url.searchParams.getAll("warehouse").at(-1) || databendCloudHostWarehouse(url.hostname);
  const ignored = databendIgnoredParameters(url.search);
  // An sslmode BendSQL does not read leaves the mode unset, so the port is the scheme's: 80 for +http, else 443.
  const plain = tls.sslMode === undefined ? plainScheme : tls.sslMode === "disable";
  return {
    type: "databend",
    host: url.hostname || "localhost",
    port: url.port || (plain ? "80" : "443"),
    user: url.username ? safeDecodeURIComponent(url.username) : undefined,
    password: url.password ? safeDecodeURIComponent(url.password) : undefined,
    database: url.pathname.length > 1 ? safeDecodeURIComponent(url.pathname.slice(1)) : undefined,
    ...(warehouse ? { warehouse } : {}),
    ...tls,
    allowInsecureAuth: false,
    ...(notice ? { notice } : {}),
    ...(cautions.length > 0 ? { cautions } : {}),
    ...(ignored.names.length > 0 ? { ignoredParameters: ignored.names } : {}),
    ...(ignored.unnamed > 0 ? { unnamedParameters: ignored.unnamed } : {}),
  };
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
  if (trimmed.startsWith("db2://")) return "db2";
  if (trimmed.startsWith("couchbase://") || trimmed.startsWith("couchbases://")) return "couchbase";
  if (trimmed.startsWith("libsql://")) return "libsql";
  if (/^databend(\+https?)?:\/\//.test(trimmed)) return "databend";
  if (isSnowflakePaste(input.trim())) return "snowflake";
  if (trimmed.startsWith("clickhouse://") || trimmed.startsWith("http://") || trimmed.startsWith("https://"))
    return "clickhouse";
  if (/^server\s*=/i.test(trimmed)) return "mssql";
  return null;
}

// ---------------------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------------------

const SNOWFLAKE_SCHEMES = ["jdbc:snowflake://", "snowflake://"] as const;
const SNOWSIGHT_HOST = "app.snowflake.com";

/** The Snowflake scheme `text` starts with, in any case (`JDBC:SNOWFLAKE://` too, SF-024), or undefined. */
function snowflakeScheme(text: string): (typeof SNOWFLAKE_SCHEMES)[number] | undefined {
  const lower = text.toLowerCase();
  return SNOWFLAKE_SCHEMES.find((scheme) => lower.startsWith(scheme));
}

/** The host of an `https://` text, lower-cased, or undefined when it is not a URL. */
function httpsHost(text: string): string | undefined {
  if (!text.toLowerCase().startsWith("https://")) return undefined;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether the paste is Snowflake's: a `jdbc:snowflake://` or `snowflake://` URL, an `https://` URL whose host is a
 * Snowflake host or Snowsight, or a bare Snowflake host. An identifier with no suffix is not claimed: it would claim
 * any word, so it is typed in Account instead.
 */
function isSnowflakePaste(text: string): boolean {
  if (snowflakeScheme(text) !== undefined) return true;
  const host = httpsHost(text);
  if (host !== undefined) return host === SNOWSIGHT_HOST || isSnowflakeHost(host);
  return !/[\s/:?#@]/.test(text) && isSnowflakeHost(text);
}

/** Applied to their own fields, value percent-decoded once. */
const SNOWFLAKE_FIELD_PARAMETERS: Readonly<Record<string, "user" | "warehouse" | "database" | "schema" | "role">> = {
  user: "user",
  warehouse: "warehouse",
  db: "database",
  database: "database",
  schema: "schema",
  role: "role",
};
const SNOWFLAKE_PASSPHRASE_PARAMETERS = new Set(["private_key_pwd", "private_key_file_pwd", "private_key_passphrase"]);
const SNOWFLAKE_AUTHENTICATORS: Readonly<Record<string, "keypair" | "pat">> = {
  snowflake_jwt: "keypair",
  programmatic_access_token: "pat",
};
/** An inline key, refused by name; each spelled as the refusal names it. */
const SNOWFLAKE_INLINE_KEYS = ["private_key", "private_key_raw", "privatekey", "private_key_base64"];
/** A parameter naming a file or a directory on the machine, refused by name; each spelled as the refusal names it. */
const SNOWFLAKE_PATH_PARAMETERS = [
  "private_key_file",
  "private_key_path",
  "token_file_path",
  "client_config_file",
  "DIAGNOSTICS_ALLOWLIST_FILE",
  "CRL_RESPONSE_CACHE_DIR",
  "ocsp_response_cache_filename",
  "crl_cache_dir",
];
const SNOWFLAKE_DIAG_PATH = /^connection_diag_.*_path$/;
/** Named as not applied, value never applied; each spelled as the notice names it. */
const SNOWFLAKE_NAMED_PARAMETERS = [
  "password",
  "passcode",
  "oauthClientSecret",
  "oauth_client_secret",
  "proxyPassword",
  "insecureMode",
  "disableOCSPChecks",
];
const SNOWFLAKE_TLS_PARAMETERS = new Set(["insecureMode", "disableOCSPChecks"]);

/** The list entry `name` (lower-cased) matches, in the list's own spelling, or undefined. */
function listed(list: readonly string[], name: string): string | undefined {
  return list.find((entry) => entry.toLowerCase() === name);
}

/** The refusal of a parameter that is refused by name, or undefined. */
function snowflakeParameterRefusal(name: string): string | undefined {
  const inline = listed(SNOWFLAKE_INLINE_KEYS, name);
  if (inline !== undefined) return SNOWFLAKE_PASTE_SENTENCES.inlineKey(inline);
  const path = listed(SNOWFLAKE_PATH_PARAMETERS, name);
  if (path !== undefined) return SNOWFLAKE_PASTE_SENTENCES.path(path);
  if (SNOWFLAKE_DIAG_PATH.test(name)) return SNOWFLAKE_PASTE_SENTENCES.path("connection_diag_*_path");
  return undefined;
}

/** `Not applied: <names>, and <k> other parameters.`, with the TLS sentence when a TLS name is among them. */
function snowflakeNotice(names: readonly string[], others: number): string | undefined {
  if (names.length === 0 && others === 0) return undefined;
  const counted = `${others} other parameter${others === 1 ? "" : "s"}`;
  let text: string;
  if (names.length === 0) text = `Not applied: ${counted}.`;
  else text = `Not applied: ${names.join(", ")}${others > 0 ? `, and ${counted}` : ""}.`;
  return names.some((name) => SNOWFLAKE_TLS_PARAMETERS.has(name)) ? `${text} ${SNOWFLAKE_PASTE_SENTENCES.tls}` : text;
}

/** The address, userinfo and query of a Snowflake paste, split by hand so no URL parser reinterprets the account. */
function splitSnowflakePaste(text: string): {
  scheme: (typeof SNOWFLAKE_SCHEMES)[number] | undefined;
  account: string;
  user?: string;
  hasPassword: boolean;
  segments: string[];
  query: string;
} {
  const scheme = snowflakeScheme(text);
  if (scheme === undefined && !text.toLowerCase().startsWith("https://")) {
    return { scheme, account: text, hasPassword: false, segments: [], query: "" };
  }
  const rest = text.slice(scheme === undefined ? "https://".length : scheme.length).split("#")[0];
  const queryAt = rest.indexOf("?");
  const address = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  const slash = address.indexOf("/");
  const authority = slash === -1 ? address : address.slice(0, slash);
  const segments = (slash === -1 ? "" : address.slice(slash + 1))
    .split("/")
    .filter((segment) => segment !== "")
    .map(safeDecodeURIComponent);
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:443$/, "");
  const colon = userinfo?.indexOf(":") ?? -1;
  const user =
    userinfo === undefined ? undefined : safeDecodeURIComponent(colon === -1 ? userinfo : userinfo.slice(0, colon));
  const hasPassword = colon !== -1;
  if (scheme === undefined) {
    // An https:// account URL is read by the Account field's own reader; a Snowsight URL carries the account in its
    // first two segments, and every other segment of either is the page's own.
    const snowsight = host.toLowerCase() === SNOWSIGHT_HOST;
    return {
      scheme,
      account: snowsight ? `https://${host}/${segments.slice(0, 2).join("/")}` : `https://${host}`,
      user,
      hasPassword,
      segments: [],
      query,
    };
  }
  return { scheme, account: safeDecodeURIComponent(host), user, hasPassword, segments, query };
}

/**
 * A Snowflake paste decomposed into the form's fields. The text itself is never kept: no `connectionString`,
 * and no value but an applied one leaves this function. A refused account, an inline key or a path parameter refuses
 * the whole paste, and nothing but `type` and the sentence is set.
 */
function parseSnowflakeURL(text: string): ParsedConnection {
  const parts = splitSnowflakePaste(text);
  const reading = readSnowflakeAccount(parts.account);
  if (!reading.ok) return { type: "snowflake", refusal: reading.refusal, discardPaste: true };
  // Snowflake serves its API on 443 only, so an account URL naming another port is refused as the Account field does.
  if (reading.url !== null && reading.url.port !== "") {
    return { type: "snowflake", refusal: SNOWFLAKE_FIELD_SENTENCES.accountFormat, discardPaste: true };
  }
  // A JDBC URL carries the whole host, so one outside Snowflake's domains is refused, never read as a locator and a
  // region under it; a snowflake:// URL may carry the host or the bare account identifier.
  const foreign =
    parts.scheme === "jdbc:snowflake://"
      ? !isSnowflakeHost(parts.account)
      : parts.scheme === "snowflake://" && !isSnowflakeHost(parts.account) && !isAccountIdentifier(parts.account);
  if (foreign) return { type: "snowflake", refusal: SNOWFLAKE_PASTE_SENTENCES.foreignHost, discardPaste: true };

  const fields: Partial<Record<"user" | "warehouse" | "database" | "schema" | "role", string>> = {};
  if (parts.user) fields.user = parts.user;
  if (parts.segments[0]) fields.database = parts.segments[0];
  if (parts.segments[1]) fields.schema = parts.segments[1];
  const named: string[] = parts.hasPassword ? ["the password in the URL"] : [];
  let others = 0;
  let authMethod: "keypair" | "pat" | undefined;
  let token: string | undefined;
  let privateKeyPassphrase: string | undefined;

  for (const piece of parts.query.split("&")) {
    if (piece === "") continue;
    const equals = piece.indexOf("=");
    const name = safeDecodeURIComponent(equals === -1 ? piece : piece.slice(0, equals)).toLowerCase();
    const value = equals === -1 ? "" : safeDecodeURIComponent(piece.slice(equals + 1));
    const refused = snowflakeParameterRefusal(name);
    if (refused !== undefined) return { type: "snowflake", refusal: refused, discardPaste: true };
    if (Object.hasOwn(SNOWFLAKE_FIELD_PARAMETERS, name)) {
      if (value !== "") fields[SNOWFLAKE_FIELD_PARAMETERS[name]] = value;
    } else if (SNOWFLAKE_PASSPHRASE_PARAMETERS.has(name)) {
      if (value !== "") privateKeyPassphrase = value;
    } else if (name === "token") {
      if (value !== "") token = value;
    } else if (name === "authenticator") {
      const method = value.toLowerCase();
      if (Object.hasOwn(SNOWFLAKE_AUTHENTICATORS, method)) authMethod = SNOWFLAKE_AUTHENTICATORS[method];
      else if (!named.includes("authenticator")) named.push("authenticator");
    } else {
      const spelled = listed(SNOWFLAKE_NAMED_PARAMETERS, name);
      if (spelled === undefined) others++;
      else if (!named.includes(spelled)) named.push(spelled);
    }
  }

  if (token !== undefined && authMethod === undefined) authMethod = "pat";
  const notice = snowflakeNotice(named, others);
  return {
    type: "snowflake",
    host: reading.host,
    ...fields,
    ...(token !== undefined ? { password: token } : {}),
    ...(authMethod !== undefined ? { authMethod } : {}),
    ...(privateKeyPassphrase !== undefined ? { privateKeyPassphrase } : {}),
    ...(notice !== undefined ? { notice } : {}),
  };
}
