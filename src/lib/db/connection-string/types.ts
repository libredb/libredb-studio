import type { DatabaseType, SSLMode } from "@/lib/types";

/**
 * One query parameter kept in the spelling it was pasted in. The lookup is
 * case-insensitive, but the banner quotes the parameter back at the user, so what it echoes
 * has to be their text and not a normalised form of it.
 */
export interface RawParam {
  readonly name: string;
  readonly value: string;
}

/**
 * What a TLS parameter resolved to: a mode the form can hold, or the parameter itself when
 * it has no representation. Never both, and never a fallback to "disable".
 */
export interface TLSIntent {
  sslMode?: SSLMode;
  unmappedTLSParam?: string;
}

/** A URL's query parameters, keyed by the lower-cased name, each kept in the spelling it was pasted in. */
export type QueryParams = ReadonlyMap<string, RawParam>;

/** One field a type's load check refuses, and the sentence it is refused with. */
export interface SeedFieldRefusal {
  readonly field: string;
  readonly sentence: string;
}

/** The fields a load check reads, as the file writes them: every one may be absent or a `${...}` reference. */
export type SeedCheckedFields = Readonly<
  Partial<Record<"host" | "user" | "authMethod" | "privateKey" | "password" | "role", string>>
>;

/**
 * What a pasted connection string parses to: the engine it names, the fields it fills, and the sentences the form shows
 * beside it. Declared here, beside the rows that produce it, so an engine's paste reader and the parser that walks the
 * rows import one shape and neither imports the other.
 */
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
 * How one engine reads a pasted connection string. The parser walks the rows that have one in the order the registry
 * declares (`CONNECTION_STRING_PASTE_ORDER`) and hands the text to the first row that claims it, so a row claims only
 * its own engine's spellings, and a test holds every fixture text to exactly one claimant or a declared overlap.
 */
export interface ConnectionStringPaste {
  /**
   * Whether this row claims generic transport schemes (`http://`, `https://`) that other rows can claim on their own
   * hosts: such a row sits after every other row in the order, and each row that shares a text with it is declared
   * in `CONNECTION_STRING_PASTE_OVERLAPS`.
   */
  readonly catchAll: boolean;
  /**
   * Whether this row reads `text`, the trimmed paste with its scheme lower-cased and everything after `://` as typed:
   * a spelling it connects with, or one it recognises and refuses by name.
   */
  readonly claims: (text: string) => boolean;
  /**
   * Whether `detectConnectionStringType` names this engine for `text`, the trimmed paste lower-cased whole: the
   * spellings it connects with, which can be fewer than it claims.
   */
  readonly names: (text: string) => boolean;
  /** The text this row claims, as the form's fields, or null when it is no URL the row can read. */
  readonly parse: (text: string) => ParsedConnection | null;
  /**
   * The forms the connection dialog's Paste URL box names for this row, in the words its hint and its refusal both
   * use: only forms `parse` connects with, so the box never promises a paste the form cannot honour.
   */
  readonly formats: readonly string[];
}

/** What one engine's connection string is: the scheme shown for it, the TLS its URL query carries, its seed checks. */
export interface ConnectionStringSpec {
  /**
   * The canonical URI scheme the engine is reachable by, for the engines that HAVE one, otherwise `null`.
   *
   * Deliberately partial, and the gaps are the point: SQLite is a file path, LibreDB is
   * embedded in the process, and Druid is reached over plain HTTP through the form. Inventing
   * `sqlite://` or `druid://` to make every row carry one would put a scheme on the login
   * page that `parseConnectionString` rejects - a claim the product does not honour,
   * which is the class of defect issue #425 exists to remove.
   *
   * Aliases the parser also accepts (`postgresql://`, `mongodb+srv://`, `rediss://`,
   * `sqlserver://`, `couchbases://`, and ClickHouse's `http(s)://`) are not listed: this field
   * answers "what is the one scheme to show a reader for this engine", not "what will parse".
   *
   * `tests/unit/lib/connection-string-parser.test.ts` pins the schemes against the parser
   * itself - every scheme must round-trip to its own `DatabaseType` - so they cannot
   * drift away from the rows' paste claims without failing CI.
   */
  readonly scheme: string | null;
  /** The TLS a URL carries in its QUERY STRING, for the engines that put it there, otherwise `null`. */
  readonly readTls: ((params: QueryParams) => TLSIntent) | null;
  /** How the engine reads a pasted connection string, or `null` for an engine the paste box never names. */
  readonly paste: ConnectionStringPaste | null;
  /**
   * The checks the engine's provider makes before any socket, run at load on the fields the seed file writes (SF-038),
   * each skipped for a field `isReference` says holds a reference; `null` for an engine not checked at load.
   */
  readonly validateSeed:
    | ((conn: SeedCheckedFields, isReference: (value: string | undefined) => boolean) => readonly SeedFieldRefusal[])
    | null;
}
