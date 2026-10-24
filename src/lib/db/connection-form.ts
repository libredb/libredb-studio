/**
 * The connection dialog's form data for every engine: the label, the default host and port, the fields and their
 * labels, hints, placeholders, placement, rules, options and conditions, the SSL, SSH and host-URI flags, the
 * credential warnings and the import, with the readers of them. Everything an entry of `DB_UI_CONFIG` says apart from
 * its icon and its colour.
 *
 * UI-free: nothing here imports `react`, `lucide-react` or a module under src/components/, so a bundle with no React
 * can load it. The web dialog reads it through `DB_UI_CONFIG` (src/lib/db-ui-config.ts), which adds each engine's icon
 * and colour to its entry here; the VS Code extension's child reads it through `engines/list`.
 * tests/unit/lib/db/connection-form.test.ts holds both: the run-time import graph, and `DB_UI_CONFIG` as this table
 * plus an icon and a colour.
 */
import type { HostUriScheme } from "@/lib/connection-host-uri";
import type { ConnectionImportDeclaration } from "@/lib/connection-import";
import {
  CONNECTION_FIELDS,
  type ConnectionField,
  type ConnectionFieldOf,
  type FieldPlacement,
  type PlaceableField,
} from "@/lib/db/connection-fields";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import { MODBUS_READ_ONLY_HINT } from "@/lib/db/providers/industrial/modbus/constants";
import {
  SNOWFLAKE_FIELD_SENTENCES,
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/** What the connection dialog reads for one engine, apart from the icon and colour `DB_UI_CONFIG` adds. */
export interface ConnectionFormSpec {
  label: string;
  defaultPort: string;
  /**
   * What the Host box holds when this engine is chosen after another one, where the previous engine's host means
   * nothing here: a Snowflake account is not a host name, so a carried `localhost` would sign in to an account of
   * that name. Absent, the box keeps what it held, as it always has.
   */
  defaultHost?: string;
  showConnectionStringToggle: boolean;
  /**
   * The fields the dialog draws and `buildConnection` saves, taken by reference from `CONNECTION_FIELDS` in
   * src/lib/db/connection-fields.ts, which holds the lists in a module of their own so the seed loader reads them
   * without this form table.
   */
  connectionFields: readonly ConnectionField[];
  /**
   * The connection dialog's label for a field, where this engine names the field differently from
   * the dialog's own word (#1085). Read through `connectionFieldLabel`, so an engine relabels a
   * field by declaring it here rather than by another per-type branch in `ConnectionModal.tsx`.
   */
  fieldLabels?: Partial<Record<ConnectionField, string>>;
  /**
   * A sentence the connection dialog draws under a field, where this engine needs one said before
   * the user reaches an error (#1085). Read through `connectionFieldHint`.
   */
  fieldHints?: Partial<Record<ConnectionField, string>>;
  /**
   * The connection dialog's placeholder for a field, where this engine's example differs from the dialog's own.
   * Read through `connectionFieldPlaceholder`; the `host`, `user`, `password`, `database`, `schema`, `region`,
   * `location`, `privateKey`, `amqpPort` and `connectionString` boxes read it. A declared `schema` example also stands in for the dialog's
   * own sentence under that box, so the engine's hint is the only one drawn there.
   */
  fieldPlaceholders?: Partial<Record<ConnectionField, string>>;
  /**
   * Where the connection dialog draws each of the `PLACEABLE_FIELDS` this engine takes: `"advanced"` behind the
   * Advanced accordion, `"open"` with the other fields. Read through `connectionFieldPlacement`. Required by
   * `FieldPlacementDeclaration` for every engine that takes one of those fields and refused for every other engine,
   * so there is no default to fall through to. The dialog draws the accordion only for an engine that places one there.
   */
  fieldPlacement?: Readonly<Partial<Record<PlaceableField, FieldPlacement>>>;
  /**
   * The sentence under the Host box derived from what is typed in it, such as the host a Snowflake account
   * identifier resolves to, or `undefined` while the text derives nothing. Drawn in place of the static `fieldHints`
   * entry for `host` while it answers; absent, the static hint is drawn as before.
   */
  hostHint?: (host: string) => string | undefined;
  /**
   * The server a Host text names, for telling whether a pasted connection string names the server already in the box
   * or another one, whose credentials the form then drops. Read through `hostIdentity`; absent, the text trimmed and
   * lower-cased.
   */
  hostIdentity?: (host: string) => string;
  /**
   * The sentence under the connection dialog's Read-only toggle, where this engine's mode differs from
   * the dialog's own sentence, which says the mode can be turned off. Neo4j declares one because its
   * connections are read-only whether or not the box is ticked (spec A7). Read through `readOnlyHint`.
   */
  readOnlyHint?: string;
  /**
   * The checks the connection dialog runs on a field before Test Connection and Save send anything, each refusal a
   * sentence that names the field and never repeats its value. Read through `connectionFieldRefusal`. The provider
   * runs the same checks again at connect, because a seed or an API call never passes the dialog; this declaration
   * says them before a request is made.
   */
  fieldRules?: Partial<Record<ConnectionField, ConnectionFieldRule>>;
  /**
   * The choices of a field the connection dialog draws as a select rather than a text box, each a
   * stored value and its label, offered after an empty "None" choice that stores nothing (#1088).
   * The dialog draws the select where the engine takes the field, the same condition
   * `buildConnection` writes it on, so an entry that declares options names the field in
   * `connectionFields` too. Only Kafka's SASL mechanism is declared this way; a per-type boolean in
   * `ConnectionModal.tsx` is what this replaces.
   */
  fieldOptions?: Partial<Record<ConnectionField, readonly { readonly value: string; readonly label: string }[]>>;
  /**
   * A field the connection dialog draws only while another field holds one value, such as Snowflake's private key,
   * drawn only while Sign-in is Key pair. Read through `connectionFieldShown`: the dialog draws such a field only
   * while the condition holds, `buildConnection` writes it only then, and `connectionFieldRefusal` checks its rules
   * only then, so a hidden field is neither saved nor required. Absent means every field the engine takes is drawn.
   */
  fieldShownWhen?: Partial<Record<ConnectionField, { readonly field: ConnectionField; readonly equals: string }>>;
  /**
   * `false` where this engine's connections may not carry an SSH tunnel (#1088), absent meaning the
   * dialog offers the tunnel. Read through `offersSshTunnel`, never directly.
   */
  showSshTunnel?: false;
  /**
   * `false` where the engine's endpoint fixes its own TLS, so an SSL mode would be read by nothing. Absent
   * means the dialog offers the panel. Read through `offersSslPanel`, never directly.
   */
  showSslPanel?: false;
  /**
   * The schemes the connection dialog's Host box takes as a whole address, split into Host and Port on paste
   * and at save (src/lib/connection-host-uri.ts), absent meaning the box takes a host alone, as it always has.
   * Read through `hostUriSchemes`, never directly. The connection-string box is a different reader and keeps
   * `http://` and `https://` for ClickHouse.
   */
  hostAcceptsUri?: readonly HostUriScheme[];
  /**
   * The credentials this engine warns about, taken by reference from `CREDENTIAL_WARNINGS` in
   * src/lib/db/credential-warnings.ts through a getter every entry is given below, and never written out in an
   * entry, so the dialog's warning and the seed loader's refusal read one record. That module holds the data in a
   * module of its own so the seed loader reads it without this form table.
   */
  credentialWarnings?: readonly CredentialWarning[];
  /**
   * An import the connection dialog offers for this engine: the action's label and a loader of a browser-side parser
   * that reads a pasted text into entries, one of which fills the form (src/lib/connection-import.ts). Absent means the
   * dialog offers no import. The dialog reads it from the entry, never from a type branch, and offers it only for a new
   * connection.
   */
  connectionImport?: ConnectionImportDeclaration;
}

/** A check the connection dialog runs on one field before Test Connection and Save (`fieldRules`). */
export interface ConnectionFieldRule {
  /** The refusal of a blank field; absent, a blank field passes. */
  readonly required?: string;
  /** A field that is not blank must match `pattern` whole, or `sentence` is the refusal. */
  readonly format?: { readonly pattern: RegExp; readonly sentence: string };
  /** A field that is not blank and passes `format` must hold `min` to `max` characters, or `sentence` is the refusal. */
  readonly charRange?: { readonly min: number; readonly max: number; readonly sentence: string };
  /**
   * A field that is not blank and passes the two above is read by this function, whose answer is the refusal, or
   * undefined where it passes: for a check a pattern cannot state, such as Snowflake's Account, which the dialog reads
   * with the very function `connect()` reads it with.
   */
  readonly check?: (value: string) => string | undefined;
}

/**
 * Databend's form checks (design 6.3), in the provider's own sentences. The provider module is server code the dialog
 * cannot import, so the warehouse pattern is a copy of its `WAREHOUSE_NAME`, and tests/unit/lib/db-ui-config.test.ts
 * holds the copy, and both sentences, to the provider's.
 */
export const DATABEND_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  user: {
    required:
      "User is required: Databend signs in every request as a SQL user, root on a fresh self-hosted node. Nothing was sent.",
  },
  warehouse: {
    format: {
      pattern: /^[A-Za-z0-9_-]{1,63}$/,
      sentence:
        "Warehouse must be 1 to 63 letters, digits, hyphens or underscores, as the warehouse is named in Databend Cloud. Nothing was sent.",
    },
  },
});

/**
 * The sentences the connection dialog draws under Databend's fields (design 6.1), exported so the docs and the form's
 * own refusals can be held to the same words.
 */
export const DATABEND_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "A host name or address, or a pasted https:// address, which is split into Host and Port. Databend Cloud: the host from Connect in the Cloud console, on port 443 with SSL mode verify-system. Self-hosted: the query node, port 8000 unless http_handler_port was changed.",
  user: "A SQL user. On Databend Cloud: cloudapp, or a user created with CREATE USER; the email you sign in to the Cloud console with is not a SQL user.",
  database: "The current database for names a statement does not qualify. Empty means default.",
  warehouse:
    "Databend Cloud: the warehouse= value of the DSN from Connect. A suspended warehouse resumes on the first statement, opening the connection included, because it reads the object tree, and is billed while it runs; with Warehouse set, Studio sends no background health checks. Self-hosted: leave empty unless your cluster routes requests by warehouse.",
  allowInsecureAuth:
    "Ticked, the password crosses the network in cleartext to this host. Databend Cloud never needs this: it serves HTTPS on port 443.",
});

/**
 * The sentences the connection dialog draws under Snowflake's fields, exported so the docs can be held to them.
 */
export const SNOWFLAKE_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  // Drawn while the Account text does not read yet; once it reads, the derived "Studio connects to" hint replaces it.
  host: "An account identifier such as myorg-myaccount, or its https:// URL.",
  user: "The user's login name (LOGIN_NAME).",
  privateKey: "Paste the private key's contents. Studio reads no key file.",
  privateKeyPassphrase: "Only for an encrypted key.",
  password: "A programmatic access token for this user.",
  warehouse: "Leave empty to use the user's default warehouse. Queries need one; browsing does not.",
  database: "Opened first in the tree, and the default for unqualified names.",
  schema: "The default schema for unqualified names.",
  role: "Every statement runs as this role; Studio checks it when it connects.",
});

/**
 * Snowflake's form checks, in the provider's own sentences. The account module is pure, with no import of its own,
 * so the dialog reads its pattern and sentences directly rather than a copy.
 */
export const SNOWFLAKE_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  // connect()'s own reading of the text (SF-025), so the dialog refuses exactly what Test would, a padded account
  // passes, and the hint under the box appears only for a text both take.
  host: { required: SNOWFLAKE_FIELD_SENTENCES.accountEmpty, check: snowflakeAccountRefusal },
  user: { required: SNOWFLAKE_FIELD_SENTENCES.userEmpty },
  // Each credential is required only under its own sign-in method: `fieldShownWhen` hides the other one, and a
  // hidden field's rules are not checked.
  privateKey: { required: SNOWFLAKE_FIELD_SENTENCES.keyEmpty },
  password: { required: SNOWFLAKE_FIELD_SENTENCES.tokenEmpty },
  role: { required: SNOWFLAKE_FIELD_SENTENCES.roleEmpty },
});

/**
 * The sentences the connection dialog draws under Apache Spark's fields, exported so the provider doc and its test can
 * be held to the same words.
 */
export const SPARK_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "The host of the Spark Connect server, or of a TLS proxy in front of it. Spark Connect listens on 15002 unless the server was started on another port. Paste an sc:// address with Paste URL.",
  password:
    "The server's spark.connect.authenticate.token (Spark 4.0 and later), sent on every call. Leave it empty for a server without a token. Studio sends a token only over TLS or an SSH tunnel, unless the host is this machine.",
  database:
    "The catalog unqualified names resolve in, and the one the tree opens first. Empty: the server's default catalog.",
  schema:
    "The namespace in that catalog, written as in Spark SQL: parts joined by dots, a part with other characters in backticks. Empty: the catalog's current namespace.",
});

/**
 * Apache Spark's form checks, in the provider's own sentences. The provider's modules are server code the dialog may
 * not import, so the three patterns and the four sentences are copies of the exports of
 * src/lib/db/providers/sql/spark/namespace.ts and connection-options.ts, and tests/unit/lib/db-ui-config.test.ts holds
 * each copy to the provider's.
 */
export const SPARK_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  host: {
    required:
      "Host is required: the name or address of the Spark Connect server, or of the TLS proxy in front of it. Nothing was sent.",
  },
  password: {
    format: {
      pattern: /^(?:[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?)?$/,
      sentence:
        "Token takes printable ASCII with no space at either end: a gRPC header cannot carry other characters, and Spark compares the token exactly. Nothing was sent.",
    },
  },
  database: {
    format: {
      pattern: /^[^.\p{Cc}]{1,255}$/u,
      sentence: "Catalog takes one catalog name without dots, as spark.sql.catalog.<name> names it. Nothing was sent.",
    },
  },
  schema: {
    format: {
      pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*|`(?:[^`]|``)+`)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|`(?:[^`]|``)+`)){0,7}$/,
      sentence:
        "Namespace takes a Spark SQL namespace: parts joined by dots, each a letter or _ followed by letters, digits or _, or written in backticks with a backtick doubled; at most 8 parts. Nothing was sent.",
    },
  },
});

/**
 * The form checks of S3-compatible object storage, in the provider's own sentences. The provider module
 * is server code the dialog cannot import, so the three patterns and the access key ID's range are copies of the
 * exports of src/lib/db/providers/objectstore/s3/connection-options.ts and constants.ts, and
 * tests/unit/lib/db-ui-config.test.ts holds each copy, and each sentence, to the provider's.
 */
export const S3_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  user: {
    format: {
      pattern: /^[\x21-\x2b\x2d\x2e\x30-\x3c\x3e-\x7e]+$/,
      sentence:
        "Access key ID must be printable ASCII without spaces, commas, equals signs or slashes, because it is sent inside the signed Authorization header. Nothing was sent.",
    },
    charRange: {
      min: 3,
      max: 512,
      sentence:
        "Access key ID holds 3 to 512 characters, because S3 servers issue no shorter ID and it is sent inside the signed Authorization header. Nothing was sent.",
    },
  },
  database: {
    format: {
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/,
      sentence:
        "Bucket must be 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit. Nothing was sent.",
    },
  },
  region: {
    format: {
      pattern: /^[A-Za-z0-9_-]{1,64}$/,
      sentence: "Region must be 1 to 64 letters, digits, hyphens or underscores, such as us-east-1. Nothing was sent.",
    },
  },
});

/**
 * The sentences the connection dialog draws under the fields of S3-compatible object storage, exported so
 * the docs and the tests can be held to the same words.
 */
export const S3_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "A host name or address, or a pasted http:// or https:// endpoint such as http://localhost:9000, which is split into Host and Port. The endpoint only: a bucket goes under Bucket, never in the address. MinIO and RustFS serve on port 9000 unless configured otherwise, Garage on 3900. If Studio runs in a container, localhost is that container: use host.docker.internal.",
  user: "The access key ID. It is stored and shown in the clear, like a user name. Leave both keys empty only for a bucket that allows anonymous reads: Studio then sends unsigned requests, never this server's own cloud credentials.",
  password:
    "The secret access key. Studio's server signs every request with it and never sends it to the S3 server. Fill in both keys, or neither.",
  database:
    "Optional. With a bucket here, Studio reads only that bucket and never lists the others, which a key limited to one bucket needs. Empty: every bucket this key can list.",
  region:
    "The region every request is signed for. Empty means us-east-1, which MinIO accepts unless it was started with a region of its own. Garage: its s3_region setting. AWS: the bucket's region.",
  allowInsecureAuth:
    "Ticked, Studio connects to this host over plain HTTP. The secret access key is never sent to this server, but bucket and object names, listings and previewed contents travel in the clear, readable by anyone on the path, and a captured request can be replayed for several minutes. Choose an SSL mode under SSL / TLS, or an SSH tunnel, wherever the server offers one.",
});

/**
 * Kubernetes' form checks, in the provider's own sentences. The provider module is server code the dialog cannot
 * import, so each pattern is a copy of its rule, and tests/unit/lib/db-ui-config.test.ts holds each copy and sentence
 * to the provider's. The API path, the TLS server name and the token are checked by the provider at Test Connection,
 * and so is the count of the Namespaces list (at most 1,000), which a pattern does not hold.
 */
export const KUBERNETES_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  database: {
    format: {
      pattern: /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/,
      sentence:
        "Default namespace must be a DNS-1123 label: at most 63 lower-case letters, digits or hyphens, starting and ending with a letter or digit. Nothing was sent.",
    },
  },
  namespaces: {
    format: {
      pattern: /^[\s,]*[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?([\s,]+[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*[\s,]*$/,
      sentence:
        "Namespaces must list DNS-1123 labels separated by commas or spaces: at most 63 lower-case letters, digits or hyphens each, starting and ending with a letter or digit. Nothing was sent.",
    },
  },
});

/** The sentences the connection dialog draws under Kubernetes' fields, exported so the docs can be held to them. */
export const KUBERNETES_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "The API server: a host name or address, or a pasted https:// address such as https://api.example:6443, which is split into Host and Port. A path, such as Rancher's /k8s/clusters/<id>, goes under API path. If Studio runs in a container, localhost is that container: use the cluster's Docker network or host.docker.internal. A typed address also needs SSL Mode under SSL / TLS: verify-full with the cluster's CA, or verify-system; the default, disable, is refused for any host but this machine.",
  port: "kubeadm, k3s and kind serve on 6443; managed clusters (EKS, GKE, AKS, Rancher) usually on 443.",
  password:
    "A bearer token, without the word Bearer. A ServiceAccount token bound to view or studio-reader is the safest choice; kubectl create token lasts one hour unless --duration says otherwise. Leave empty when a client certificate under SSL / TLS signs in, or for kubectl proxy.",
  database:
    "Empty means default, as kubectl reads it: the namespace the tree opens on and the console reads when a statement names none.",
  namespaces:
    "Optional: the namespaces the tree lists, separated by commas or spaces. Set it when this identity may not list namespaces; Studio then reads no namespace list.",
  apiPath: "Optional: a path every request goes under, such as /k8s/clusters/c-m-abc12 for a cluster behind Rancher.",
  tlsServerName:
    "Optional: the name the API server's certificate is checked against, when it differs from Host (kubeconfig tls-server-name).",
});

/**
 * RabbitMQ's form checks, in the provider's own sentences. The provider module is server code the dialog cannot
 * import, so each pattern is a copy of `readAmqpPort` and `readPathPrefix` in
 * src/lib/db/providers/stream/rabbitmq/connection-options.ts, and tests/unit/lib/db-ui-config.test.ts holds each copy to
 * the provider's rule over the same values. The provider names the exact Path prefix shape it refuses; the dialog's
 * one pattern names all of them at once.
 */
export const RABBITMQ_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  amqpPort: {
    format: {
      pattern: /^(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
      sentence: "AMQP port must be a whole number from 1 to 65535, such as 5672. Nothing was sent.",
    },
  },
  apiPath: {
    format: {
      pattern: /^(?:\/|(?:\/(?!api(?:\/|$))(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~!$&'()*+,;=:@-]+)+\/?)$/,
      sentence:
        "Path prefix starts with / and takes a plain path such as /rabbitmq: no empty, . or .. segment, no %, ? or #, and no segment named api. Nothing was sent.",
    },
  },
});

/** The sentences the connection dialog draws under RabbitMQ's fields, exported so the docs can be held to them. */
export const RABBITMQ_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "A host name, or a pasted https:// management address. A path such as /rabbitmq goes in Path prefix. An amqp:// or amqps:// URL is not taken here: enter its host, its port as AMQP port, and its user and password in their own fields.",
  port: "15671 with TLS; 443 when a TLS proxy serves the management API",
  amqpPort:
    "5672, or 5671 with TLS. Only for stream reads; leave empty to browse only. Test Connection checks the management API only; the AMQP port is checked on the first read.",
  apiPath:
    "The path the management API is served under, for management.path_prefix or a reverse proxy location, such as /rabbitmq. Empty for a direct connection.",
  allowInsecureAuth:
    "Sends the username and password in clear text to the management API and the AMQP port, where anyone on the path can read them. Prefer an SSL mode and the TLS ports 15671 and 5671.",
});

/**
 * What one type's entry says about placement: where each placeable field it takes is drawn, required and total over
 * those fields; a type that takes none declares nothing. Adding a placeable field to a type's `CONNECTION_FIELDS` row
 * therefore fails to compile until its entry decides where the field goes.
 */
export type FieldPlacementDeclaration<T extends DatabaseType> = [
  Extract<ConnectionFieldOf<T>, PlaceableField>,
] extends [never]
  ? { readonly fieldPlacement?: never }
  : { readonly fieldPlacement: { readonly [F in Extract<ConnectionFieldOf<T>, PlaceableField>]: FieldPlacement } };

export const CONNECTION_FORM: {
  [T in DatabaseType]: Omit<ConnectionFormSpec, "fieldPlacement"> & FieldPlacementDeclaration<T>;
} = {
  postgres: {
    label: "PostgreSQL",
    defaultPort: "5432",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.postgres,
  },
  mysql: {
    label: "MySQL",
    defaultPort: "3306",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.mysql,
  },
  sqlite: {
    label: "SQLite",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.sqlite,
  },
  duckdb: {
    label: "DuckDB",
    // Embedded: nothing is listening anywhere, so there is no port to default.
    defaultPort: "",
    // No URI scheme exists to paste - DuckDB's own tooling takes a path - so the
    // provider declares `supportsConnectionString: false` and this toggle stays off.
    showConnectionStringToggle: false,
    // Exactly `["database"]`, which is the shape `isFileBased()` below tests for: it
    // is what makes ConnectionModal render "Database File Path" instead of a
    // host/user/password section. One extra field here would silently take the file
    // input away.
    connectionFields: CONNECTION_FIELDS.duckdb,
  },
  libsql: {
    // The protocol's name rather than the product's: one connection here reaches a
    // self-hosted libSQL server OR Turso Cloud, and naming the managed product would
    // read as though the self-hosted one belonged somewhere else.
    label: "libSQL",
    // sqld's own default HTTP port. A Turso Cloud connection names no port at all -
    // it is TLS on 443, which the transport picks up from the ssl setting.
    defaultPort: "8080",
    // `libsql://<database>-<org>.turso.io?authToken=<jwt>` is the URL Turso's CLI
    // prints, so there IS a canonical form to paste - unlike Trino's JDBC URL.
    showConnectionStringToggle: true,
    // `user` is for a self-hosted server started with SQLD_HTTP_AUTH, which checks a
    // user name and password as HTTP Basic: the transport sends Basic whenever a
    // connection names a user and the bearer token otherwise. The form still labels
    // `password` "Auth Token" (fieldLabels below), the credential Turso Cloud and
    // a JWT-checking server take, and the hint below says when that box is a password.
    // No `database`: the database IS the host on Turso Cloud, and a self-hosted server
    // serves one per namespace hostname.
    connectionFields: CONNECTION_FIELDS.libsql,
    fieldLabels: {
      // libSQL's usual credential is a TOKEN its server minted (Turso prints one per
      // database), so the shared `password` field holds a JWT here and is relabelled
      // rather than left to be guessed at. A self-hosted server started with
      // SQLD_HTTP_AUTH checks a user name and password instead, and the Username box's
      // declared hint below says when this box takes the password.
      password: "Auth Token",
    },
    fieldPlaceholders: {
      connectionString: "libsql://<database>-<org>.turso.io?authToken=<jwt>",
    },
    fieldHints: {
      user: "Only for a self-hosted libSQL server started with SQLD_HTTP_AUTH, which checks a user name and password as HTTP Basic: the Auth Token box then takes the password. Leave it empty for Turso Cloud and for a server that checks tokens.",
      password:
        "Turso Cloud mints this per database (`turso db tokens create`). A self-hosted libSQL server started without authentication takes none - leave it empty.",
    },
  },
  mongodb: {
    label: "MongoDB",
    defaultPort: "27017",
    showConnectionStringToggle: true,
    connectionFields: CONNECTION_FIELDS.mongodb,
    fieldPlacement: { authSource: "open" },
    fieldPlaceholders: {
      connectionString: "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
    },
    fieldHints: {
      // MongoDB keeps its users in a database of their own, and the driver checks the
      // credentials against whichever database the URI names when nothing says otherwise.
      // So the ordinary deployment - users in `admin`, data elsewhere - had no way through
      // the discrete fields at all, and failed as a credentials error.
      //
      // In the open rather than behind the Advanced accordion for the
      // reason Cassandra's field is: the deployment that needs it is
      // the ordinary one, and the failure without it is a credentials error
      // that names nothing. The connection-string mode has no such field -
      // a pasted URI carries `?authSource=` itself.
      authSource:
        "The database the user was created in, usually admin. Leave empty when the credentials live in the database above.",
    },
  },
  redis: {
    label: "Redis",
    defaultPort: "6379",
    showConnectionStringToggle: false,
    // `user` is the Redis 6 ACL user. It belongs here because `RedisProvider.connect()`
    // authenticates with it (as ioredis's `username`) and docs/providers/redis.md has
    // documented it as a connection field all along - this list was the one place that
    // disagreed, and since it decides what a save WRITES, the value never reached the
    // driver that #502 taught to send it.
    connectionFields: CONNECTION_FIELDS.redis,
  },
  oracle: {
    label: "Oracle",
    defaultPort: "1521",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.oracle,
    fieldPlacement: { serviceName: "advanced" },
    fieldHints: {
      serviceName: "If empty, the Database Name field is used as the service name.",
    },
  },
  // IBM Db2 LUW (#786). No connection-string toggle: a `db2://` paste fills the fields, the Oracle
  // precedent. No password hint: a declared hint is drawn whatever SSL Mode says, and the cleartext
  // warning belongs only to a connection without TLS, where the `allowInsecureAuth` box carries it.
  // The consent box's sentence is declared here too, so a second engine that takes the box says its own.
  db2: {
    label: "Db2 LUW",
    defaultPort: "50000",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.db2,
    fieldHints: {
      allowInsecureAuth:
        "With no SSL mode this driver sends the password in cleartext, so the connection is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    },
  },
  mssql: {
    label: "SQL Server",
    defaultPort: "1433",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.mssql,
    fieldPlacement: { instanceName: "advanced" },
    fieldHints: {
      instanceName: "For named instances (e.g. SQLEXPRESS). Leave empty for default instance.",
    },
  },
  couchbase: {
    label: "Couchbase",
    // Management port. The query ports are discovered from the cluster at connect
    // time (issue #262, decision 3), so only this one is ever stored.
    defaultPort: "8091",
    showConnectionStringToggle: true,
    connectionFields: CONNECTION_FIELDS.couchbase,
    fieldLabels: {
      // Couchbase pins one bucket per connection (issue #262, decision 4), so the shared
      // `database` field holds a bucket name and the form must say so.
      database: "Bucket Name",
    },
    fieldPlaceholders: {
      connectionString: "couchbase://localhost:8091/travel-sample  or  couchbases://cb.<id>.cloud.couchbase.com/...",
    },
  },
  clickhouse: {
    label: "ClickHouse",
    // The HTTP interface port. The provider speaks HTTP only, so the native
    // protocol port 9000 is never a valid value here (issue #264).
    defaultPort: "8123",
    showConnectionStringToggle: true,
    connectionFields: CONNECTION_FIELDS.clickhouse,
    fieldPlaceholders: {
      // The MongoDB example, which the dialog showed every toggle engine but Couchbase and libSQL before this
      // declaration existed. Kept as it was, although it is not a ClickHouse address.
      connectionString: "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
    },
  },
  druid: {
    label: "Apache Druid",
    // The Router port. The Broker on 8082 serves the identical POST /druid/v2/sql and
    // needs no different configuration (live-verified, issue #265); the Router is the
    // default only because it also fronts the console and the management-proxied APIs.
    defaultPort: "8888",
    // No URI convention exists for Druid's HTTP SQL API - its JDBC driver addresses
    // Avatica (jdbc:avatica:remote:url=...), and http:// / https:// already resolve to
    // ClickHouse in connection-string-parser.ts. There is nothing to paste.
    showConnectionStringToggle: false,
    // Deliberately no "database": INFORMATION_SCHEMA.SCHEMATA reports exactly one
    // catalog, always named `druid`, so a database selector would be a control with no
    // effect. Credentials stay offered because a cluster running druid-basic-security
    // needs them; a default install ignores the Authorization header entirely.
    connectionFields: CONNECTION_FIELDS.druid,
  },
  elasticsearch: {
    label: "Elasticsearch",
    // 9200 for both products and both schemes: a TLS deployment serves HTTPS on the
    // SAME port rather than on a second well-known one, so unlike ClickHouse there is
    // no 8443-shaped alternative (the provider's SEARCH_DEFAULT_PORT says the same).
    defaultPort: "9200",
    // No URI convention to paste: the provider is addressed by host and port like
    // Druid, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Nothing was added there for these two ids.
    showConnectionStringToggle: false,
    // Deliberately no "database": an index has no namespace above it - measured, ES's
    // SHOW TABLES reports only a catalog (the cluster name) and OpenSearch reports
    // TABLE_SCHEM null, and the catalog is not addressable in a statement - so a
    // database selector would be a control with no effect. Credentials stay offered
    // because a cluster running the security plugin needs them; a stock node ignores
    // the Authorization header entirely (measured).
    //
    // apiKeyId/apiKeySecret here and not on opensearch below (#708): the transport
    // sends them only when its dialect spec says the product accepts the ApiKey wire
    // scheme, which nothing has measured for OpenSearch. Offering the fields there
    // would let an operator fill in a pair the transport refuses rather than sends.
    connectionFields: CONNECTION_FIELDS.elasticsearch,
  },
  opensearch: {
    label: "OpenSearch",
    // Same 9200 floor, same reason - the fork kept the port.
    defaultPort: "9200",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.opensearch,
  },
  trino: {
    // The product's own name, with no vendor word in front of it: "Trino" is what the
    // project calls itself, unlike "Apache Druid".
    label: "Trino",
    // The coordinator's HTTP port, and the SAME number under TLS: a secured cluster
    // serves on whatever port its operator chose, so inventing a well-known HTTPS
    // alternative would point credentials at a port nothing is listening on.
    defaultPort: "8080",
    // No URI to paste. Trino's canonical URL is a JDBC one
    // (`jdbc:trino://host:port/catalog/schema`), which the shared parser does not
    // accept, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Two engines cannot own one scheme.
    showConnectionStringToggle: false,
    // `database` IS offered here, which is where this id parts company with Druid and
    // the two search engines: a coordinator fronts MANY catalogs (measured on 476,
    // `SHOW CATALOGS` answers jmx, memory, system, tpcds, tpch) and a connection pins
    // one, the way a PostgreSQL connection pins a database. The form labels it
    // "Catalog" rather than "Database" (fieldLabels below).
    connectionFields: CONNECTION_FIELDS.trino,
    fieldLabels: {
      // Trino pins one CATALOG the way Couchbase pins a bucket (issue #424 Phase 2).
      // "Database" would be the wrong word twice over: a Trino catalog is a whole external
      // system (`hive`, `iceberg`, `tpch`), and the field is the one thing a user cannot
      // guess - a coordinator with no catalog selected resolves no table at all.
      database: "Catalog Name",
    },
    fieldPlaceholders: {
      database: "tpch",
    },
    fieldHints: {
      // Measured on Trino 476 with authentication DISABLED: a request
      // carrying `Authorization: Basic` over plain HTTP is answered 401,
      // "Password not allowed for insecure authentication". So a
      // password is a TLS-only credential here, and typing one into an
      // http:// connection BREAKS a connection that would otherwise
      // work. The provider refuses the combination outright; this says
      // so before the user reaches that error.
      password:
        "Trino refuses a password over plain HTTP. Enable TLS below, or leave this empty to connect as an unauthenticated user.",
      database: "The Trino catalog to open, such as tpch or hive. Its schemas are the level below.",
    },
  },
  cassandra: {
    // The project's own name, vendor word included, exactly as "Apache Druid" is
    // spelled here: the ASF name is how this engine is universally written.
    label: "Apache Cassandra",
    // The native protocol port. There is no second protocol to reach: the old Thrift
    // port (9160) is gone from 4.0 onwards, and 7000/7001 are internode.
    defaultPort: "9042",
    // No URI to paste. The driver takes contact points plus a REQUIRED
    // `localDataCenter`, and no URI convention in use carries the second; `cassandra://`
    // is in no branch of connection-string-parser.ts, so the toggle would promise a
    // paste the form cannot honour.
    showConnectionStringToggle: false,
    // `database` IS offered and it holds a KEYSPACE - the same mapping Trino makes
    // onto a catalog. Measured on 5.0.9: with no keyspace pinned, `SELECT … FROM
    // customers` answers "No keyspace has been specified. USE a keyspace, or
    // explicitly specify keyspace.tablename", and a keyspace that does not exist
    // fails the CONNECT rather than the first statement. The form labels it
    // "Keyspace" (fieldLabels below).
    connectionFields: CONNECTION_FIELDS.cassandra,
    fieldPlacement: { localDataCenter: "open" },
    fieldLabels: {
      // Cassandra pins one KEYSPACE the same way (issue #424 Phase 4). "Database" is the
      // wrong word here too: a keyspace carries the replication settings, not just a
      // namespace, and without one pinned an unqualified table name resolves to nothing
      // at all - measured on 5.0.9, "No keyspace has been specified. USE a keyspace, or
      // explicitly specify keyspace.tablename".
      database: "Keyspace Name",
    },
    fieldPlaceholders: {
      database: "probe",
    },
    fieldHints: {
      database:
        "The keyspace to open. Tables inside it are the level below; statements can still name any keyspace in full.",
      // Drawn in the open, not behind the Advanced accordion that holds
      // Oracle's service name and SQL Server's instance name. Those two are
      // refinements; this one is mandatory - `cassandra-driver` refuses to
      // build a load-balancing policy without it, so a connection with this
      // empty cannot open at all.
      localDataCenter:
        "Required: the Cassandra driver refuses to connect without it. A stock single-node install reports datacenter1; the server lists the ones it has if this is wrong.",
    },
  },
  prometheus: {
    label: "Prometheus",
    // The port the HTTP API and the web UI share. The same number under TLS: a secured server
    // serves on whatever port its operator chose, so inventing an HTTPS alternative would point
    // credentials at a port nothing is listening on.
    defaultPort: "9090",
    // No URI convention to paste, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Two engines cannot own one scheme.
    showConnectionStringToggle: false,
    // Deliberately no "database": the server holds one TSDB and every API read is addressed to
    // it, so a selector would be a control with no effect (#1085 6.1), the Druid shape. `user` and
    // `password` are HTTP Basic; a password with no user is sent as a bearer token.
    connectionFields: CONNECTION_FIELDS.prometheus,
    // Declared here rather than as one more boolean in ConnectionModal.tsx (#1085 3.3): the
    // password box is the one field whose meaning depends on another field being empty. The user
    // box is "User" because the hint and the provider's credential refusal both name it so.
    fieldLabels: { user: "User", password: "Password or token" },
    fieldHints: { password: "Leave User empty to send this as a bearer token." },
  },
  kafka: {
    label: "Apache Kafka",
    // The broker port a stock install listens on, and the same number under TLS: a secured
    // listener serves on whatever port its operator chose.
    defaultPort: "9092",
    // No URI convention to paste: a Kafka client takes a bootstrap address, and nothing in
    // connection-string-parser.ts reads a Kafka URI.
    showConnectionStringToggle: false,
    // No SSH tunnel: a tunnel forwards one address, and a Kafka client reads from every broker at
    // the address the broker advertises (docs/providers/kafka.md). Read through offersSshTunnel, so
    // the dialog neither offers a tunnel nor sends one left in its state; the provider still
    // refuses a tunnelled connection that arrives another way.
    showSshTunnel: false,
    // No database field: one connection is one cluster (docs/providers/kafka.md). The SASL
    // mechanism is a select declared here, not an isKafka branch in the dialog.
    connectionFields: CONNECTION_FIELDS.kafka,
    fieldLabels: { saslMechanism: "SASL mechanism" },
    fieldHints: { saslMechanism: "PLAIN and SCRAM require TLS" },
    fieldOptions: {
      saslMechanism: [
        { value: "PLAIN", label: "PLAIN" },
        { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
        { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512" },
      ],
    },
  },
  etcd: {
    label: "etcd",
    // The client port etcd listens on.
    defaultPort: "2379",
    // No URI convention to paste: etcdctl takes endpoints, which Host and Port hold (#1089 6.1).
    showConnectionStringToggle: false,
    // No database field: one connection is one cluster. User and Password are etcd's password sign-in; with
    // both empty, a client certificate under SSL / TLS signs in as its Common Name. The hints below say which
    // field decides which, since a refusal of E1 or E2 is otherwise the first the user hears of it.
    connectionFields: CONNECTION_FIELDS.etcd,
    fieldHints: {
      host: "A name or address only. For etcdctl's --endpoints=https://10.0.0.5:2379, type 10.0.0.5 here, 2379 in Port, and choose an SSL mode under SSL / TLS.",
      user: "Leave User and Password empty to sign in with the client certificate under SSL / TLS (shown in verify-ca and verify-full): etcd uses its Common Name as the user when the server runs with --client-cert-auth. When both are set, etcd uses the password.",
      password:
        "etcd receives the password, then a token on every call, so a password needs an SSL mode other than disable, with or without an SSH tunnel.",
    },
  },
  neo4j: {
    label: "Neo4j",
    // The Bolt port. The HTTP port (7474) serves the browser and the HTTP API, which this provider never uses.
    defaultPort: "7687",
    // No URI scheme to paste: the provider builds its bolt:// URI from Host, Port and the SSL panel, and
    // connection-string-parser.ts reads no Neo4j URI (spec 6.1).
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered: a bolt:// URI dials the one server it names, unlike a
    // routing neo4j:// URI, which this provider never builds. An empty database is the server's home database.
    connectionFields: CONNECTION_FIELDS.neo4j,
    fieldHints: { database: "Leave empty to use the server's home database." },
    // The dialog's own sentence says the mode can be turned off, which is false here (spec A7).
    readOnlyHint:
      "Neo4j connections are read-only in this version, whether or not this is ticked: this user's write privileges are never used.",
  },
  milvus: {
    label: "Milvus",
    // One endpoint carries gRPC with TLS on or off (vector-family spec 5.2); 9091 is the management port, never dialled.
    defaultPort: "19530",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted vendor address belongs in the
    // Host box, which splits it (hostAcceptsUri below, vector-family spec 3.12).
    showConnectionStringToggle: false,
    // The database is optional and sent with every call; the provider reads `config.user` and `config.database`,
    // which the write-list test of tests/unit/lib/db-ui-config.test.ts holds.
    connectionFields: CONNECTION_FIELDS.milvus,
    // The Prometheus precedent: one password box also carries a token when User is empty (vector-family spec 5.2).
    fieldLabels: { password: "Password or token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address such as a Zilliz Cloud endpoint, which is split into Host and Port. Port 9091 is Milvus's management port, which Studio never dials.",
      database: "Optional; empty means default. A dbName in a request body overrides it.",
      user: "Optional. At most 32 characters, starting with a letter. Leave it empty to put a token in Password or token.",
      password:
        "Milvus receives the password or token on every call, so a password needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
    },
    hostAcceptsUri: ["http", "https"],
  },
  qdrant: {
    label: "Qdrant",
    // The REST port. 6334 is gRPC and 6335 the cluster's internal port, neither of which the provider dials (vector-family spec 4.4).
    defaultPort: "6333",
    // The connection-string box reads http:// and https:// as ClickHouse, so the vendor's address belongs in the
    // Host box, which splits it (hostAcceptsUri below, vector-family spec 3.12).
    showConnectionStringToggle: false,
    // No Database box: Qdrant has no container level. No User field: Qdrant has no user name, and the provider
    // refuses a non-empty one from a seed or the API naming the field (vector-family spec 4.4). The key or JWT is the password.
    connectionFields: CONNECTION_FIELDS.qdrant,
    fieldLabels: { password: "API key or JWT" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address such as http://localhost:6333, which is split into Host and Port. Studio dials this REST port only, never Qdrant's gRPC port 6334 or its cluster port 6335.",
      password:
        "Qdrant receives the API key or JWT on every request, so a key needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. A read-only or collection-scoped key with an expiry is the safest choice.",
    },
    hostAcceptsUri: ["http", "https"],
  },
  weaviate: {
    label: "Weaviate",
    // REST and GraphQL share this port (#1566 spec 6.1); 50051 is gRPC, which the provider never dials.
    defaultPort: "8080",
    // The connection-string box reads http:// and https:// as ClickHouse, so the vendor's address belongs in the
    // Host box, which splits it (hostAcceptsUri below), as Qdrant's.
    showConnectionStringToggle: false,
    // No Database box: Weaviate has no container level. No User field: an API key and an OIDC access token are both
    // a bearer token, which is the password, and the provider refuses a non-empty user naming the field.
    connectionFields: CONNECTION_FIELDS.weaviate,
    fieldLabels: { password: "API key or token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address such as a Weaviate Cloud endpoint, which is split into Host and Port. Studio dials this port only, never Weaviate's gRPC port 50051.",
      password:
        "Weaviate receives the API key or OIDC access token on every request, so a key needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. A key for a user with only the viewer role is the safest choice.",
    },
    hostAcceptsUri: ["http", "https"],
  },
  influxdb: {
    // One connection type per query language: this one sends InfluxQL over the v1 /query API of 1.x, 2.x and 3.x.
    label: "InfluxDB (InfluxQL)",
    defaultPort: "8086",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted address belongs in the Host
    // box, which splits it (hostAcceptsUri below).
    showConnectionStringToggle: false,
    // The Prometheus precedent: one password box carries a 1.x password or, with User empty, a 2.x or 3.x token. The
    // last field is the consent to send it without TLS, drawn while SSL Mode is disable (InfluxDB spec I7).
    connectionFields: CONNECTION_FIELDS.influxdb,
    fieldLabels: { password: "Password or token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.",
      password: "1.x: the user's password. 2.x and InfluxDB 3: an API token, with User empty.",
      database:
        'A 1.x database, a 2.x bucket, or an InfluxDB 3 database: the default for a run, not a filter. Empty: the only database the credential can list, or name it in the statement as "db".."measurement".',
      allowInsecureAuth:
        "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.",
    },
    // The dialog's own sentence says the mode can be turned off, which is false here: Studio sends no write.
    readOnlyHint: "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.",
    hostAcceptsUri: ["http", "https"],
  },
  influxdb3: {
    // InfluxDB 3 Core's SQL over /api/v3/query_sql.
    label: "InfluxDB 3 (SQL)",
    defaultPort: "8181",
    showConnectionStringToggle: false,
    // No User field: InfluxDB 3 has no user name, its token is the password, and the connection layer refuses a user
    // from a seed or the API naming the field.
    connectionFields: CONNECTION_FIELDS.influxdb3,
    fieldLabels: { password: "Token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.",
      password:
        "Empty only for a server started with --without-auth. On InfluxDB 3 Core every token is an admin token.",
      database:
        "The one InfluxDB 3 database this connection reads. Empty: the only database the token can list; with more than one, set it here.",
      allowInsecureAuth:
        "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.",
    },
    readOnlyHint: "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.",
    hostAcceptsUri: ["http", "https"],
  },
  oxia: {
    label: "Oxia",
    // The client port of `oxia standalone` and of every data server's public listener (R01, R02 12).
    defaultPort: "6648",
    // No URI convention: the CLI takes `-a host:port`, which Host and Port hold (DECISIONS O5).
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.oxia,
    fieldLabels: { password: "Token", database: "Namespace", dataServers: "Data servers" },
    // The namespace an empty Namespace means, where the dialog would show "db" (ruling R34).
    fieldPlaceholders: { database: "default" },
    fieldHints: {
      host: "A name or address only. For Pulsar's oxia://host:6648/ns, type host here, 6648 in Port and ns in Namespace. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      password:
        "An OIDC token, sent as a bearer token on every call; empty for a server without authentication. A token grants read and write on every namespace: Oxia has no authorization. A token needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
      database:
        "Empty means default, the only namespace of oxia standalone. Names are case sensitive, and a cluster's namespaces are in its coordinator configuration.",
      dataServers:
        "Only for a cluster that advertises other addresses: every data server's public address (servers[].public in the coordinator configuration) as host:port, separated by commas or spaces, at most 64. List every server, not only today's leaders. Patterns are not accepted, because the token would follow any address a pattern matches. Leave empty for oxia standalone.",
      allowInsecureAuth:
        "Oxia receives the token on every call, so with no SSL mode it crosses the network in cleartext, to the host and to every data server. A token sent without TLS to a host that is not this machine is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    },
    readOnlyHint:
      "Oxia connections are read-only in this version, whether or not this is ticked: Studio sends Oxia no write.",
  },
  databend: {
    label: "Databend",
    // Self-hosted's HTTP handler port. Port 443 comes from a DSN or an https:// paste, never from the SSL mode or a host
    // heuristic, so a Databend Cloud connection filled in by hand sets it.
    defaultPort: "8000",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted address belongs in the Host box,
    // which splits it (hostAcceptsUri below); a databend:// DSN is the paste handler's.
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered. The last field is the consent to send the password without TLS,
    // drawn while SSL Mode is disable.
    connectionFields: CONNECTION_FIELDS.databend,
    fieldLabels: { warehouse: "Warehouse" },
    // No User example: `root` contradicted the dialog's own warning against signing in as root with no password, and
    // the hint under the box names the users to choose (SF-039), so the box shows the dialog's own `user`.
    fieldPlaceholders: { database: "default" },
    fieldHints: DATABEND_FIELD_HINTS,
    fieldRules: DATABEND_FIELD_RULES,
    hostAcceptsUri: ["http", "https"],
  },
  bigquery: {
    label: "BigQuery",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.bigquery,
    fieldLabels: {
      database: "Project ID",
      schema: "Default dataset",
      password: "Service-account key JSON or access token",
      location: "Location",
    },
    // Always HTTPS to googleapis.com with the system trust store, and a tunnel would forward one address of
    // several (the API, the token endpoint, the metadata server), so neither panel would be read.
    showSshTunnel: false,
    showSslPanel: false,
    fieldPlaceholders: {
      database: "my-gcp-project",
      location: "detected (e.g. EU, US, europe-west3)",
      // Short enough for the box at phone width; the full text measured 446 px in a 448 px box at 1440 px (SF-039),
      // so what an empty box means is said in the hint below it.
      password: "key JSON, a ya29… token, or empty",
    },
    fieldHints: {
      password:
        "The whole key file's JSON, or a bearer token. Empty uses the server's own credentials, where the deployment enables them.",
    },
  },
  snowflake: {
    label: "Snowflake",
    defaultPort: "",
    // Account opens empty, with only its placeholder, rather than holding the previous engine's host.
    defaultHost: "",
    // A pasted Snowflake address is decomposed into fields; no connection string is stored.
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.snowflake,
    fieldLabels: {
      host: "Account",
      user: "User",
      authMethod: "Sign-in",
      privateKey: "Private key",
      privateKeyPassphrase: "Passphrase",
      password: "Access token",
      warehouse: "Warehouse",
      database: "Database",
      schema: "Schema",
      role: "Role",
    },
    fieldOptions: {
      authMethod: [
        { value: "keypair", label: "Key pair" },
        { value: "pat", label: "Programmatic access token" },
      ],
    },
    fieldPlaceholders: {
      // The identifier alone: the URL form was cut at "snowflakecomputing.c" at 1440 px (SF-043), and the hint says it.
      host: "myorg-myaccount",
      privateKey: "-----BEGIN PRIVATE KEY-----",
      // No example for these three: a name such as user or default reads as a value already typed, and each box's
      // hint says what it takes.
      user: "",
      database: "",
      schema: "",
    },
    fieldHints: SNOWFLAKE_FIELD_HINTS,
    // Once the Account reads, the hint names the host Studio connects to.
    hostHint: snowflakeHostHint,
    // `myorg-myacct` and `https://MYORG-MYACCT.snowflakecomputing.com` are one account.
    hostIdentity: snowflakeHostIdentity,
    fieldRules: SNOWFLAKE_FIELD_RULES,
    // One credential at a time: the key and its passphrase for a key pair, the token for an access token.
    fieldShownWhen: {
      privateKey: { field: "authMethod", equals: "keypair" },
      privateKeyPassphrase: { field: "authMethod", equals: "keypair" },
      password: { field: "authMethod", equals: "pat" },
    },
    // TLS is fixed (the certificate checked, the account host as its name) and nothing is tunnelled, so neither panel
    // would be read.
    showSshTunnel: false,
    showSslPanel: false,
  },
  spark: {
    label: "Apache Spark",
    defaultPort: "15002",
    // A pasted sc:// address is decomposed into fields; no connection string is stored.
    showConnectionStringToggle: false,
    // No User box: every request uses one fixed Spark Connect user id, and Token is the credential. Both the SSH
    // tunnel and the SSL / TLS panel stay offered: TLS reaches Spark through an operator's TLS-terminating proxy.
    connectionFields: CONNECTION_FIELDS.spark,
    fieldLabels: { host: "Host", port: "Port", password: "Token", database: "Catalog", schema: "Namespace" },
    fieldPlaceholders: { database: "server default (spark_catalog)", schema: "catalog default" },
    fieldHints: SPARK_FIELD_HINTS,
    fieldRules: SPARK_FIELD_RULES,
  },
  s3: {
    // "S3-compatible": the servers this provider was verified on are named in docs/providers/s3.md, and AWS is not one.
    label: "S3-compatible object storage",
    // The API port MinIO and RustFS serve on by default. Garage serves on 3900 and an https:// paste sets 443.
    defaultPort: "9000",
    // No URI mode: an s3:// URI names a bucket and a key, never an endpoint and a credential, and the connection-string
    // box reads http:// and https:// as ClickHouse, so a pasted endpoint belongs in the Host box, which splits it.
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered. The last field is the consent to plain HTTP, drawn while SSL Mode
    // is disable.
    connectionFields: CONNECTION_FIELDS.s3,
    fieldLabels: {
      host: "Endpoint host",
      user: "Access key ID",
      password: "Secret access key",
      database: "Bucket",
      region: "Region",
      allowInsecureAuth: "Connect without TLS",
    },
    // What an empty box means, as Oxia's "default" (ruling R34 there).
    fieldPlaceholders: { database: "all buckets", region: "us-east-1" },
    fieldHints: S3_FIELD_HINTS,
    fieldRules: S3_FIELD_RULES,
    // The dialog's own sentence says the mode can be turned off, which is false here.
    readOnlyHint:
      "S3-compatible connections are read-only in this version, whether or not this is ticked: Studio sends no write.",
    hostAcceptsUri: ["http", "https"],
  },
  kubernetes: {
    label: "Kubernetes",
    // kubeadm, k3s and kind; a pasted https:// address without a port sets 443.
    defaultPort: "6443",
    // No URI mode: a cluster address belongs in the Host box, which splits it, and a kubeconfig is not a URI.
    showConnectionStringToggle: false,
    // No User field: basic authentication is refused, and the provider refuses a user from a seed or the API naming
    // the field. The SSL panel carries the CA and a client certificate; the SSH tunnel stays offered.
    connectionFields: CONNECTION_FIELDS.kubernetes,
    fieldLabels: {
      host: "API server",
      password: "Token",
      database: "Default namespace",
      namespaces: "Namespaces",
      apiPath: "API path",
      tlsServerName: "TLS server name",
    },
    // What an empty Default namespace means.
    fieldPlaceholders: { database: "default" },
    fieldHints: KUBERNETES_FIELD_HINTS,
    fieldRules: KUBERNETES_FIELD_RULES,
    // The dialog's own sentence says the mode can be turned off, which is false here: Studio sends no write.
    readOnlyHint:
      "Kubernetes connections are read-only in this version, whether or not this is ticked: Studio sends the cluster no write.",
    hostAcceptsUri: ["https", "http"],
    // The dialog loads the importer, and the yaml parser it reads with, only when the import opens.
    connectionImport: {
      label: "Import kubeconfig",
      load: () => import("@/lib/kubernetes/kubeconfig-import").then((module) => module.importKubeconfig),
    },
  },
  mqtt: {
    label: "MQTT",
    // The IANA-assigned port for MQTT. 8883 is the TLS port, which the SSL mode selects.
    defaultPort: "1883",
    // Host and Port hold the broker. A `mqtt://` URI adds nothing the two fields do not say.
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.mqtt,
    // `database` carries the discovery filter, as Oxia's carries a namespace: one connection reads one filter.
    fieldLabels: { database: "Topic filter" },
    fieldPlaceholders: { database: "#" },
    fieldHints: {
      host: "A name or address only. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      user: "A broker username, if the broker checks one; empty for a broker that does not.",
      password:
        "The password for that username. A password needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
      database:
        "What to subscribe to. Empty means #, every topic except the broker's own $SYS tree, which no # filter reaches. A narrower filter reads less and finishes sooner. $share/, $queue/ and $exclusive/ are refused: each one takes messages away from the devices that need them, and no broker reports that it happened.",
      allowInsecureAuth:
        "With no SSL mode the username and password cross the network in cleartext. A password sent without TLS to a host that is not this machine is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the broker offers one.",
    },
    readOnlyHint:
      "MQTT connections are read-only whether or not this is ticked, and not by a setting: this provider has no code that can write a PUBLISH, and its CONNECT carries no Will.",
  },
  firestore: {
    label: "Firestore",
    // No host or port: every request goes to firestore.googleapis.com, or to the emulator the server names.
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.firestore,
    fieldLabels: {
      database: "Project ID",
      schema: "Database ID",
      password: "Service-account key, ADC JSON or access token",
    },
    fieldHints: {
      database:
        "The Google Cloud project that holds the database: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. A legacy project id may carry a domain: prefix.",
      schema:
        "Empty for the (default) database. A named database's id is 4 to 63 lowercase letters, digits and hyphens, starting with a letter.",
      password:
        "Studio reads as this credential's IAM identity, and Firebase Security Rules do not apply to it. Grant a dedicated service account roles/datastore.viewer and paste its key. Every read Studio sends is billed to the project; docs/providers/firestore.md lists what each action reads. A pasted access token lasts about an hour. Leave this empty on an emulator server, or for an operator-seeded connection that uses the server's own identity.",
    },
    // The database box is the only one of the three that reads a declared placeholder: the dialog draws `***` in the
    // password box and `default` in the schema box for every engine, so their guidance lives in the hints above.
    fieldPlaceholders: { database: "my-project" },
    // Always HTTPS to googleapis.com with the system trust store, and a tunnel would forward one address of several
    // (the API, the token endpoint, the metadata server), so neither panel would be read.
    showSshTunnel: false,
    showSslPanel: false,
    readOnlyHint:
      "Firestore connections are read-only whether or not this is ticked, and not by a setting: this provider builds only the read requests of its closed request table, and none of them writes.",
  },
  rabbitmq: {
    label: "RabbitMQ",
    // The management API's port; 15671 with TLS.
    defaultPort: "15672",
    // Host and Management port hold the management API. An amqp:// URL is not taken: its parts go in their own fields.
    showConnectionStringToggle: false,
    // One tunnel carries one port, and the management API and AMQP use two, so the provider refuses a tunnel.
    showSshTunnel: false,
    hostAcceptsUri: ["http", "https"],
    connectionFields: CONNECTION_FIELDS.rabbitmq,
    fieldLabels: {
      host: "Host",
      port: "Management port",
      amqpPort: "AMQP port",
      apiPath: "Path prefix",
      allowInsecureAuth: "Send the password without TLS",
    },
    // A greyed port number would read as a default the field does not have.
    fieldPlaceholders: { amqpPort: "Empty: browse only" },
    fieldHints: RABBITMQ_FIELD_HINTS,
    fieldRules: RABBITMQ_FIELD_RULES,
    // The dialog's own sentence says the mode can be turned off, which is false here.
    readOnlyHint:
      "RabbitMQ connections are read-only whether or not this is ticked: Studio sends the broker GET requests and stream reads only, never a publish or a take.",
  },
  opcua: {
    label: "OPC UA",
    // The IANA-registered port for opc.tcp, and the one every server measured listened on. NOTHING
    // SHOWS IT TO A READER: `connectionFields` names no port, so the dialog draws no port box, and the
    // address is the endpoint URL, which carries its own. It is here for a seeded connection to read.
    defaultPort: "4840",
    // No URI toggle, because the endpoint URL IS the address: host and port are read from it, so
    // there is one place a reader can be wrong and one place to correct.
    showConnectionStringToggle: false,
    // AND NO SSL/TLS PANEL. OPC UA's transport security is its own: the security mode above and the
    // certificate pin below, with the client's key pair in the installation's PKI directory. The
    // shared panel's vocabulary - disable, require, verify-ca, verify-full - names nothing a server
    // offers, and a reader who chose `require` there was refused with a word this engine does not
    // know. The second engine to declare this, after BigQuery.
    showSslPanel: false,
    connectionFields: CONNECTION_FIELDS.opcua,
    fieldLabels: {
      host: "Endpoint URL",
      user: "Username",
      password: "Password",
      securityMode: "Security mode",
      serverCertificateThumbprint: "Server certificate",
    },
    fieldPlaceholders: { host: "opc.tcp://plc.example.net:4840/", securityMode: "SignAndEncrypt" },
    fieldHints: {
      host:
        "The endpoint exactly as you type it. This is the only address dialled: a server may advertise " +
        "another, and OPC PLC advertises its own container name, which resolves nowhere.",
      user: "A server username, if the server checks one; empty for an anonymous session.",
      password:
        "The password for that username. On a server whose UserName token declares its own policy the " +
        "password is encrypted even in None mode; where it declares none, a password to a host that is " +
        "not this machine is refused unless an SSH tunnel carries it.",
      securityMode:
        "None, Sign or SignAndEncrypt. None encrypts nothing and authenticates nobody, so a certificate " +
        "cannot be pinned there and this connection refuses the pair rather than checking a thumbprint it " +
        "read over a channel nobody authenticated. There is no fallback: a mode the server does not offer is refused rather " +
        "than quietly weakened. A secured mode also needs TRUST both ways on the first connect: the " +
        "server's certificate has to be moved into trusted/certs under the PKI directory, and the server " +
        "has to accept this client's - until then a secured connect is refused, and the refusal names the " +
        "directory.",
      serverCertificateThumbprint:
        "The SHA-256 thumbprint this server's certificate must present, as 64 hexadecimal characters; " +
        "colons and spaces are ignored. Without it any certificate the trust list accepts is accepted.",
    },
    readOnlyHint:
      "OPC UA connections are read-only whether or not this is ticked, and not by a setting: this " +
      "provider's client exposes Browse, BrowseNext, Read, HistoryRead and the session calls, and has no " +
      "code that can Write, Call a method, or subscribe.",
  },
  mtconnect: {
    label: "MTConnect",
    // The port the reference agent listens on out of the box, and the one the demo agent answered on.
    defaultPort: "5000",
    // Host and Port hold the agent. A pasted `http(s)://` address is split into them by the Host box below rather
    // than kept as a string, so there is one spelling of an address in the form.
    showConnectionStringToggle: false,
    hostAcceptsUri: ["http", "https"],
    // Host, Port and the proxy's path prefix, and nothing else: the standard defines no authentication, so the
    // form offers no credential to fill in. A proxy that asks for one answers with its own page, which the
    // provider reports as what it is rather than as an agent's refusal.
    connectionFields: CONNECTION_FIELDS.mtconnect,
    // `host` for RabbitMQ's reason, the dialog's default being "Host & Instance", and NO `port` label:
    // declaring "Port" would change nothing a reader sees and would put this engine in the census of
    // engines that declare one (tests/unit/lib/db-ui-config.test.ts), which is RabbitMQ's alone.
    fieldLabels: {
      host: "Host",
      apiPath: "Path prefix",
    },
    // The dialog's own sentence says the mode can be turned off, which is false here.
    readOnlyHint:
      "MTConnect connections are read-only whether or not this is ticked: Studio sends the agent GET requests from a closed table and nothing else.",
  },
  modbus: {
    label: "Modbus",
    // IANA `mbap`. MODBUS/TCP Security listens on 802 and the SSL panel turns it on, but the box offers the
    // plain port: a device that speaks mbaps is the rarer one, and the port is the user's to change.
    defaultPort: "502",
    // Modbus TCP has no connection string form of its own, and inventing one would be ours rather than the
    // protocol's.
    showConnectionStringToggle: false,
    // Host, Port and the register map. The protocol defines no authentication at all - no user, no password,
    // no token - so the form offers no credential to fill in; what protects a device is mbaps or a network
    // path you control.
    //
    // The map is a field on the connection, which was an open question until the write list answered it:
    // `keyof DatabaseConnection` is what a user may fill in, send and have stored, and this is a document
    // the user writes. It is not `password`, because it is not a secret and a masked document cannot be
    // corrected; BigQuery's key file sits in `password` because that one IS a credential.
    connectionFields: CONNECTION_FIELDS.modbus,
    fieldLabels: { registerMap: "Register map" },
    fieldHints: {
      registerMap:
        "A JSON array of points, each naming a unit, a table, a zero-based PDU address and a type. Without it a connection can still read a range by address, but no point has a name. Vendor documentation often counts addresses from one; these are the addresses that go on the wire.",
    },
    fieldPlaceholders: {
      registerMap: '[{ "name": "volts", "unitId": 1, "table": "holding_register", "address": 100, "type": "uint16" }]',
    },
    // The dialog's own sentence says the mode can be turned off, which is false here.
    readOnlyHint: MODBUS_READ_ONLY_HINT,
  },
  netconf: {
    label: "NETCONF",
    // IANA registers 830/tcp as `netconf-ssh` and RFC 6242 section 3 names it. Port 22 is the other
    // thing a device may listen on, and it is the user's to type.
    defaultPort: "830",
    // `netconf://` is not a scheme this product parses, and inventing one would be ours rather than
    // the protocol's. MEASURED: every address a reader would paste here, `netconf://host:830`,
    // `ssh://host:830` and a bare `host:830`, is answered `null` by the shared parser, so the box
    // would offer a reading nothing can do.
    showConnectionStringToggle: false,
    // AND NO SSL/TLS PANEL, for the reason OPC UA states above: this transport's security is its
    // own. RFC 6242 carries NETCONF over SSH, so what secures the dial is the host key pin in
    // `hostKeyFingerprint` below and not a certificate chain. The shared panel's vocabulary -
    // disable, require, verify-ca, verify-full - names nothing a NETCONF device offers.
    //
    // MEASURED: no file under `providers/network/netconf/` reads `sslMode`, `sslCa`, `sslCert`,
    // `sslKey` or `rejectUnauthorized`, so every value the panel collected was written to the
    // connection and then read by nothing. That is worse than a refusal: a reader who set
    // `verify-full` was shown no objection and got no verification either. The third engine to
    // declare this after BigQuery and OPC UA, and the first where the panel was silently inert
    // rather than answered with a word the engine does not know.
    showSslPanel: false,
    // The SSH TUNNEL panel stays, and the reason is NOT that this provider reads `sshTunnel`: it
    // does not, and `open.ts:59` says so in as many words ("`sshTunnel` is NOT where these come
    // from"). The tunnel is opened by the shared layer, before the provider is reached.
    //
    // What justifies the panel is MEASURED, in `hostkey.ts:9-12`: a wrong pin stops the handshake
    // with `Host denied (verification failed)` before any authentication packet, AND it does so
    // through an SSH tunnel as well, where the key seen inside the forward was the device's own and
    // not the bastion's - the two fingerprints differed. So a tunnel to an SSH service is not a
    // redundancy: there are two identities and the pin checks the one that matters.
    // The device's key or its password, and the device's host key fingerprint, which is what makes
    // the dial refuse an unknown device rather than trust whatever answers on the port. The
    // fingerprint has a field of its own rather than borrowing `serverCertificateThumbprint`: a
    // host key is not a certificate, and the two are checked by different code.
    connectionFields: CONNECTION_FIELDS.netconf,
  },
  snmp: {
    label: "SNMP",
    // RFC 3417 section 3.2. 162 is the trap port and is deliberately not the default: a reader
    // pointed there would be talking to a trap receiver, which answers no Get at all.
    defaultPort: "161",
    // No URI form. Measured: `snmp://` is not in `ENGINE_URI_SCHEMES`, and the house rule runs
    // one way only - an engine with this toggle on must have a scheme, and of the 36 engines
    // measured there was no exception.
    showConnectionStringToggle: false,
    // AND NO SSL / TLS PANEL. The transport is bare UDP - `client.ts` opens `createSocket("udp4")`
    // and nothing else - so there is no session for a certificate chain to secure. MEASURED: across
    // the nineteen files of this provider, `sslMode`, `sslCa`, `sslCert`, `sslKey` and
    // `rejectUnauthorized` appear zero times, so every value the panel collected was written to the
    // connection and read by nothing.
    //
    // The field below says the same thing in the other direction: the consent box's hint states
    // there is no transport security under a v2c datagram at all. A panel offering `verify-full`
    // beside that sentence contradicts it. What secures this protocol is SNMPv3's own USM, inside
    // the message rather than under it.
    showSslPanel: false,
    // AND NO SSH TUNNEL, which is a different reason and not the same one twice. Something would
    // read it - `factory.ts` opens the tunnel for any connection that carries one, with no test on
    // the engine - and that is exactly the problem: MEASURED, the shared tunnel is a local TCP
    // listener (`src/lib/ssh/tunnel.ts` is `net.createServer` plus `forwardOut`, and the word
    // `dgram` does not appear in its 392 lines). The factory then rewrites host and port to that
    // TCP endpoint, and this provider sends datagrams to it, where nothing is listening for them.
    // A tunnel the dialog offers and the transport cannot use is a box that breaks the connection
    // it promises to carry.
    showSshTunnel: false,
    // FOUR FIELDS. Three are what the provider reads; the fourth is the consent without which it
    // REFUSES to open. `connection-options.ts` turns down a v2c connection to a host that is not
    // loopback unless `allowInsecureAuth` is set, and names two ways out: choose v3, or consent to
    // the community travelling in clear. Declaring only the first three left NEITHER way on the
    // screen, so every agent off this machine was unreachable through the dialog - a defect that
    // lived between two correct halves, a refusal that reads right and a field list that is valid.
    // The v3 half is still missing and this list does not pretend otherwise: v3 needs a security
    // level, a privacy passphrase, a context name and an engine id pin, and none of those exist on
    // the shared connection record. A field collected and dropped is worse than one that is absent.
    connectionFields: CONNECTION_FIELDS.snmp,
    // The community is one shared secret with no user beside it, which is why it sits in the
    // password field and is labelled for what it is.
    // Both labels are declared because the dialog's own fallbacks are wrong here twice over: the
    // secret is a community rather than a password, and the consent box's default sentence offers
    // TLS, which SNMP has nowhere to put. What v2c lacks is not TLS, it is any transport security
    // at all; v3's answer is USM inside the message, not a tunnel under it.
    fieldLabels: {
      // `host` because the dialog's own default is "Host & Instance", which is SQL Server's
      // vocabulary: an SNMP agent has no instance, and a reader asked for one looks for a thing
      // that does not exist. Twenty-three entries declare this label for the same reason, and the
      // browser spec of this engine is what found it here.
      host: "Host",
      password: "Community",
      allowInsecureAuth: "Send the community in clear to an agent that is not on this machine",
    },
    fieldPlaceholders: { password: "" },
    fieldHints: {
      host: "A name or address only. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      password:
        "The read community. It travels in clear in every v2c datagram and there is no transport security under it, so `public` and `private` are the documented defaults every device ships with.",
      allowInsecureAuth:
        "Ticked, the community travels in clear in every datagram to an agent that is not on this machine. SNMPv2c has no authentication either: an answer can be forged by anything that can reach this connection.",
    },
    readOnlyHint:
      "SNMP connections are read-only whether or not this is ticked, and not by a setting: the outgoing valve parses every datagram and refuses any PDU that is not a Get, GetNext or GetBulk, so a Set never reaches the socket.",
  },

  sparkplug: {
    label: "Sparkplug B",
    // The IANA-assigned port for MQTT, which Sparkplug runs over. 8883 is the TLS port.
    defaultPort: "1883",
    // Host and Port hold the broker, as MQTT's do. There is no URI form that says more.
    showConnectionStringToggle: false,
    // THREE FIELDS AND NOT MQTT'S SIX, because these are the three the provider reads. `config.host`,
    // `config.port` and `config.database` are the only connection fields `SparkplugProvider` touches;
    // declaring a user or a password here would put a box on the form that the read ignores. The session
    // can carry credentials and the encoder sets their flags, but nothing passes them from a connection
    // yet, and a field that is collected and dropped is worse than one that is absent.
    connectionFields: CONNECTION_FIELDS.sparkplug,
    // `database` carries the group, as MQTT's carries a topic filter: one connection reads one group.
    fieldLabels: { database: "Group" },
    fieldPlaceholders: { database: "" },
    fieldHints: {
      host: "A name or address only. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      database:
        "One Sparkplug group id, or empty for every group. A group is a level of the topic and nothing else: it is not a thing on the broker that can be subscribed to on its own, so an empty field reads every group under spBv1.0 and a filled one reads that group alone.",
    },
    readOnlyHint:
      "Sparkplug connections are read-only whether or not this is ticked, and not by a setting: this provider's encoder has no function that writes a PUBLISH, and its CONNECT carries no Will, which is how a death certificate would be registered.",
  },
  libredb: {
    label: "LibreDB",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: CONNECTION_FIELDS.libredb,
  },
};

// Every entry's `credentialWarnings` reads its type's array from the shared record on each access, so no entry
// writes one out or holds a copy, and a declaration added to the record is the entry's at once.
for (const type of Object.keys(CONNECTION_FORM) as DatabaseType[]) {
  Object.defineProperty(CONNECTION_FORM[type], "credentialWarnings", {
    get: () => CREDENTIAL_WARNINGS[type],
    enumerable: true,
  });
}

/**
 * The order the connection dialog's engine picker offers the engines in, for display (the dialog renders them as a
 * two-column grid).
 *
 * It covers the whole `DatabaseType` union, because the same form edits saved connections, so an omitted type leaves
 * the picker with nothing selected. An engine missing from this list cannot be created at all, and the compiler cannot
 * see the omission: the array is typed `readonly DatabaseType[]`, and every subset of a union satisfies that. So
 * registering an engine everywhere else is not enough; it has to be named here too.
 * tests/unit/lib/db/connection-form.test.ts enforces the coverage.
 */
export const CONNECTION_PICKER_ORDER: readonly DatabaseType[] = Object.freeze([
  "postgres",
  "mysql",
  "sqlite",
  "oracle",
  "mssql",
  "mongodb",
  "couchbase",
  "redis",
  "libredb",
  "clickhouse",
  "druid",
  "elasticsearch",
  "opensearch",
  "trino",
  "cassandra",
  "libsql",
  "duckdb",
  "prometheus",
  "kafka",
  "etcd",
  "db2",
  "neo4j",
  "milvus",
  "qdrant",
  "influxdb",
  "influxdb3",
  "oxia",
  "databend",
  "bigquery",
  "s3",
  "kubernetes",
  "mqtt",
  "firestore",
  "rabbitmq",
  "snowflake",
  "opcua",
  "snmp",
  "sparkplug",
  "spark",
  "mtconnect",
  "modbus",
  "netconf",
  "weaviate",
]);

/** Whether the dialog offers the SSL / TLS panel: false only where the entry declares `showSslPanel: false`. */
export function offersSslPanel(type: DatabaseType): boolean {
  return CONNECTION_FORM[type].showSslPanel !== false;
}

/**
 * The connection dialog's label for one field: the engine's declared `fieldLabels` entry, or the
 * dialog's own word when the engine declares none (#1085).
 *
 * The fallback is the caller's because the dialog's own words are not one table: the `database`
 * field alone reads "Database Name", "Database File Path" or "Database Name (optional override)"
 * by the mode the form is in. `port` shares the
 * host row's label, so the dialog draws one for it only where one is declared: an engine that
 * declares none keeps the row it always had.
 */
export function connectionFieldLabel(config: ConnectionFormSpec, field: ConnectionField, fallback: string): string {
  return config.fieldLabels?.[field] ?? fallback;
}

/** The connection dialog's placeholder for one field: the engine's declared one, or the dialog's own example. */
export function connectionFieldPlaceholder(
  config: ConnectionFormSpec,
  field: ConnectionField,
  fallback: string,
): string {
  return config.fieldPlaceholders?.[field] ?? fallback;
}

/**
 * The sentence the connection dialog draws under one field, or `undefined` where the engine
 * declares none (#1085). There is no fallback: a field with no declared hint draws nothing.
 */
export function connectionFieldHint(config: ConnectionFormSpec, field: ConnectionField): string | undefined {
  return config.fieldHints?.[field];
}

/**
 * Where the connection dialog draws one placeable field the engine takes: its declared `fieldPlacement`. A field with
 * no declaration is refused rather than drawn in the open, since `FieldPlacementDeclaration` requires one wherever
 * the engine takes the field.
 */
export function connectionFieldPlacement(config: ConnectionFormSpec, field: PlaceableField): FieldPlacement {
  const placement = config.fieldPlacement?.[field];
  if (placement === undefined) throw new Error(`${config.label} declares no placement for ${field}`);
  return placement;
}

/**
 * Whether the dialog draws a field the engine takes, by the engine's `fieldShownWhen`: true when the field has no
 * condition, else whether the controlling field holds the declared value. An unset controlling field reads as its
 * first `fieldOptions` value, the choice its select shows first, so Snowflake's unset Sign-in reads as Key pair.
 */
export function connectionFieldShown(
  config: ConnectionFormSpec,
  field: ConnectionField,
  connection: Partial<Record<ConnectionField, unknown>>,
): boolean {
  const condition = config.fieldShownWhen?.[field];
  if (condition === undefined) return true;
  const value = connection[condition.field] ?? config.fieldOptions?.[condition.field]?.[0]?.value;
  return value !== undefined && String(value) === condition.equals;
}

/**
 * The first refusal of the engine's `fieldRules` for a connection as the dialog built it, or `undefined` when every
 * declared check passes. The fields are checked in `connectionFields` order, so the dialog names the first box to fix.
 * A blank field is one the dialog wrote no value for, or an empty one. A field `connectionFieldShown` hides is not
 * checked, since the dialog neither draws nor writes it.
 */
export function connectionFieldRefusal(config: ConnectionFormSpec, connection: DatabaseConnection): string | undefined {
  const values = connection as Partial<Record<ConnectionField, unknown>>;
  for (const field of config.connectionFields) {
    const rule = config.fieldRules?.[field];
    if (rule === undefined) continue;
    if (!connectionFieldShown(config, field, values)) continue;
    const value = values[field];
    if (value === undefined || value === "") {
      if (rule.required !== undefined) return rule.required;
      continue;
    }
    if (rule.format !== undefined && !rule.format.pattern.test(String(value))) return rule.format.sentence;
    if (
      rule.charRange !== undefined &&
      (String(value).length < rule.charRange.min || String(value).length > rule.charRange.max)
    ) {
      return rule.charRange.sentence;
    }
    const checked = rule.check?.(String(value));
    if (checked !== undefined) return checked;
  }
  return undefined;
}

/** The sentence under the Read-only toggle: the engine's own where it declares one, else the dialog's. */
export function readOnlyHint(config: ConnectionFormSpec): string {
  return (
    config.readOnlyHint ??
    "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission."
  );
}
