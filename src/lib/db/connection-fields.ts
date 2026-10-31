/**
 * Each connection type's connection fields and the fields only its provider reads, declared as data.
 *
 * `CONNECTION_FIELDS` names the fields the connection dialog draws for a type and `buildConnection` saves, in the
 * order the dialog draws them unless the type's form entry declares a `dialogOrder`; `CONNECTION_FORM` (src/lib/db/connection-form.ts) takes each type's array from here by
 * reference, so the list exists once, and the reason a list holds what it does stays beside that type's entry there.
 * `SEED_ONLY_FIELDS` names, per type, the fields a seed of any other type is refused for, with the sentence it is
 * refused with.
 *
 * `CONNECTION_FIELD_DESCRIPTORS` says how the dialog draws each field, as data its one renderer reads.
 *
 * Pure, browser-safe and UI-free: it imports types only. It is not in src/lib/db-ui-config.ts because that module
 * imports React icon components, which the seed loader must not load, the reason src/lib/db/credential-warnings.ts
 * is a module of its own.
 */
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/** One addressing field, named by the same list that decides whether a save writes it. */
export type ConnectionField =
  | "host"
  | "port"
  | "user"
  | "password"
  | "database"
  | "schema"
  | "connectionString"
  | "serviceName"
  | "instanceName"
  // Cassandra only, and it is REQUIRED rather than advanced: `cassandra-driver`
  // refuses to construct a load-balancing policy without a local data centre, so a
  // connection with this empty cannot open at all.
  | "localDataCenter"
  // MongoDB only: the database its credentials live in, which the driver otherwise
  // assumes is the one being opened.
  | "authSource"
  // Elasticsearch only (#708): an API key pair, sent in preference to user/password.
  | "apiKeyId"
  | "apiKeySecret"
  // Kafka only (#1088): which SASL mechanism checks the user and password, drawn as the select
  // `fieldOptions` in src/lib/db/connection-form.ts declares.
  | "saslMechanism"
  // Db2 (#786), both InfluxDB types (InfluxDB spec I7), Oxia for its token, Databend for its password, and
  // S3-compatible object storage for the connection itself, and MQTT and RabbitMQ for their passwords: the consent
  // to connect without TLS, drawn as a checkbox while SSL Mode is disable, under the sentence the type declares in
  // `fieldHints`. The provider refuses a connection with no TLS unless it is set.
  | "allowInsecureAuth"
  // Oxia only (O6): a cluster's data-server addresses, one text box.
  | "dataServers"
  // Databend and Snowflake: the warehouse statements run on, one text box. Databend sends it as the
  // X-DATABEND-WAREHOUSE header, which Databend Cloud requires; Snowflake as the warehouse field of every request
  // body, optional, the user's default warehouse when empty.
  | "warehouse"
  // BigQuery only: the job location, one text box; empty means detected.
  | "location"
  // S3-compatible object storage only: the signing region, one text box.
  | "region"
  // Kubernetes: the server path prefix (Rancher's /k8s/clusters/<id>), which RabbitMQ also takes as its Path prefix,
  // and, Kubernetes only, the namespaces the tree lists and the TLS server name, three text boxes.
  | "apiPath"
  | "namespaces"
  | "tlsServerName"
  // An AMQP 0-9-1 port, one text box of digits; no engine declares it yet.
  | "amqpPort"
  // Snowflake only: the sign-in method (a select), the pasted private key and its passphrase for a key pair, and
  // the role every statement runs as.
  | "authMethod"
  | "privateKey"
  | "privateKeyPassphrase"
  | "role"
  // OPC UA only: the security mode the server is asked for, and the server certificate pinned per
  // connection, two text boxes. The mode is OPC UA's own name rather than a translation of
  // Studio's SSL modes, which have no meaning to a server offering None, Sign and SignAndEncrypt.
  | "securityMode"
  | "serverCertificateThumbprint"
  // Modbus only: the register map, a JSON document rather than a word, drawn as a text area. The
  // protocol answers no discovery request, so this is the only thing that can name a point.
  | "registerMap"
  // NETCONF only: the device's SSH host key fingerprint, pasted from `ssh-keygen -lf`. A field of
  // its own rather than `serverCertificateThumbprint`: a host key is not a certificate, the two
  // are checked by different code, and one box for both would carry a label that is wrong half
  // the time.
  | "hostKeyFingerprint";
/** A field a seed file may carry that no connection dialog draws: a deployment fact, named by a file path or a URI. */
export type SeedOnlyField = "securityPolicyUri" | "clientCertificatePath" | "clientPrivateKeyPath";

/**
 * The fields the connection dialog draws either in the open or behind its Advanced accordion, as the engine's
 * `fieldPlacement` in src/lib/db/connection-form.ts says. Every other field is drawn in the open by the dialog's own
 * layout.
 */
export const PLACEABLE_FIELDS = ["authSource", "localDataCenter", "serviceName", "instanceName"] as const;
export type PlaceableField = (typeof PLACEABLE_FIELDS)[number];
/** Where the connection dialog draws a placeable field. */
export type FieldPlacement = "open" | "advanced";

/** The icon drawn beside a field's label, named rather than imported so this module stays UI-free. */
export type ConnectionFieldIcon = "key" | "shield" | "server" | "globe" | "database";

/**
 * What the browser may do with the text typed into a box:
 * - `free`: nothing is switched off;
 * - `unfilled`: no autofill;
 * - `unchecked`: no autofill and no spell check;
 * - `verbatim`: no autofill, spell check, autocorrection or capitalisation, for a name or a document that is not prose;
 * - `secret`: masked, never offered a saved site password, and verbatim.
 */
export type ConnectionFieldTyping = "free" | "unfilled" | "unchecked" | "verbatim" | "secret";

/** The control the connection dialog draws for a field. */
export type ConnectionFieldInput =
  /**
   * A one-line box. `numeric` asks a touch keyboard for digits; `compact` is the smaller box with no icon and no
   * label association that the Advanced accordion's fields have always had.
   */
  | {
      readonly kind: "text";
      readonly typing: ConnectionFieldTyping;
      readonly monospace?: true;
      readonly numeric?: true;
      readonly compact?: true;
    }
  /** A select of the engine's declared `fieldOptions`, after a None choice that stores nothing where `offerNone`. */
  | { readonly kind: "select"; readonly offerNone: boolean }
  /** A row of buttons, one per choice; an empty value presses `unset`, the choice the provider makes for it. */
  | { readonly kind: "toggle"; readonly choices: readonly string[]; readonly unset: string }
  /** A verbatim multi-line box, for a document such as a register map. */
  | { readonly kind: "textarea"; readonly rows: number }
  /** A pasted private key, drawn as text only while it is being typed or after Show key. */
  | { readonly kind: "key" };

/**
 * Whether and how a save writes a field the engine takes, to the connection property named like the field:
 * - `always`: as typed, even when empty, so a saved connection always says it;
 * - `nonEmpty`: byte for byte unless the box is empty, for a key, a document or a choice whose provider reads it as
 *   written, or a value whose format rule should see the spaces it holds and refuse them;
 * - `typed`: as typed unless the box holds only spaces, for a name whose quotes, case and spacing are its own;
 * - `trimmed`: trimmed, unless that leaves nothing, for a value the provider compares as a word.
 * A box that writes nothing leaves the property out, so the provider's own default applies.
 */
export type ConnectionFieldSave = "always" | "nonEmpty" | "typed" | "trimmed";

/** A row of the dialog that holds more than one field side by side. */
export interface ConnectionFieldGroup {
  /**
   * Drawn even where the engine takes none of its fields, right after the address row, or first where the engine
   * takes no address: the place, and the spacing, the login row has always had.
   */
  readonly alwaysDrawn: boolean;
  /** The dialog's own sentence under the whole row. */
  readonly note?: string;
}

const CONNECTION_FIELD_GROUP_ROWS = {
  login: { alwaysDrawn: true },
  apiKey: {
    alwaysDrawn: false,
    note: 'Kibana shows this pair under the key\'s "Beats" or "Logstash" format. Preferred over username/password when both are set; leave either half empty to fall back to them.',
  },
} as const satisfies Record<string, ConnectionFieldGroup>;
export type ConnectionFieldGroupName = keyof typeof CONNECTION_FIELD_GROUP_ROWS;

/** The dialog's rows of more than one field. A field in a row leaves it while the engine shows it under a condition. */
export const CONNECTION_FIELD_GROUPS: Readonly<Record<ConnectionFieldGroupName, ConnectionFieldGroup>> =
  Object.freeze(CONNECTION_FIELD_GROUP_ROWS);

/**
 * How the connection dialog draws one field: declared once, here, and drawn by one renderer
 * (src/components/ConnectionFieldControl.tsx), so a new field is a row of this table rather than markup in the dialog.
 * An engine's `fieldLabels`, `fieldPlaceholders`, `fieldHints`, `fieldOptions` and `fieldRules` in
 * src/lib/db/connection-form.ts win over the words here, which are the dialog's own.
 */
export type ConnectionFieldDescriptor =
  /**
   * Drawn by the dialog's own layout rather than the renderer: `address` in the Host row with its port, `uri` in the
   * connection-string mode, and `consent` in the SSL / TLS panel, where it means something only while SSL is off.
   */
  | { readonly slot: "address" | "uri" | "consent" }
  | {
      readonly slot: "body";
      /** Whether and how a save writes the field's value to the connection property of the same name. */
      readonly save: ConnectionFieldSave;
      /** The value a new form holds; absent, the empty box. */
      readonly initial?: string;
      readonly label: string;
      /** The dialog's own example; absent, the box has no placeholder and an engine's declared one is not read. */
      readonly placeholder?: string;
      readonly icon?: ConnectionFieldIcon;
      readonly control: ConnectionFieldInput;
      readonly group?: ConnectionFieldGroupName;
      /** A sentence of the dialog's own under the box, drawn only while the engine declares no placeholder for it. */
      readonly note?: string;
      /** The credential warning (src/lib/db/credential-warnings.ts) is drawn under this field. */
      readonly carriesCredentialWarning?: true;
    };

/** The descriptor of a field the renderer draws. */
export type BodyFieldDescriptor = Extract<ConnectionFieldDescriptor, { readonly slot: "body" }>;

const VERBATIM_MONO = Object.freeze({ kind: "text", typing: "verbatim", monospace: true } as const);
const UNCHECKED_MONO = Object.freeze({ kind: "text", typing: "unchecked", monospace: true } as const);

/** Each field's descriptor as literals, so the compiler can tell the fields the renderer draws from the rest. */
const CONNECTION_FIELD_DESCRIPTOR_ROWS = {
  host: { slot: "address" },
  port: { slot: "address" },
  connectionString: { slot: "uri" },
  allowInsecureAuth: { slot: "consent" },
  user: {
    slot: "body",
    save: "always",
    label: "Username",
    placeholder: "user",
    icon: "key",
    control: { kind: "text", typing: "verbatim" },
    group: "login",
  },
  password: {
    slot: "body",
    save: "always",
    label: "Password",
    placeholder: "***",
    icon: "shield",
    control: { kind: "text", typing: "secret" },
    group: "login",
    carriesCredentialWarning: true,
  },
  saslMechanism: {
    slot: "body",
    save: "nonEmpty",
    label: "SASL Mechanism",
    icon: "key",
    control: { kind: "select", offerNone: true },
  },
  // Always saved, so a saved connection says how it signs in; a new form offers the key pair first.
  authMethod: {
    slot: "body",
    save: "always",
    initial: "keypair",
    label: "Sign-in",
    icon: "key",
    control: { kind: "select", offerNone: false },
  },
  privateKey: {
    slot: "body",
    save: "nonEmpty",
    label: "Private key",
    placeholder: "",
    icon: "key",
    control: { kind: "key" },
  },
  privateKeyPassphrase: {
    slot: "body",
    save: "nonEmpty",
    label: "Passphrase",
    icon: "shield",
    control: { kind: "text", typing: "secret" },
  },
  hostKeyFingerprint: {
    slot: "body",
    save: "trimmed",
    label: "Host key fingerprint",
    placeholder: "SHA256:...",
    icon: "shield",
    control: VERBATIM_MONO,
  },
  database: {
    slot: "body",
    save: "always",
    label: "Database Name",
    placeholder: "db",
    icon: "database",
    control: VERBATIM_MONO,
  },
  dataServers: { slot: "body", save: "typed", label: "Data servers", icon: "server", control: UNCHECKED_MONO },
  warehouse: { slot: "body", save: "typed", label: "Warehouse", icon: "server", control: VERBATIM_MONO },
  location: {
    slot: "body",
    save: "trimmed",
    label: "Location",
    placeholder: "",
    icon: "globe",
    control: UNCHECKED_MONO,
  },
  // A box of spaces is saved, so the format rule refuses it rather than the provider signing for its default region.
  region: {
    slot: "body",
    save: "nonEmpty",
    label: "Region",
    placeholder: "us-east-1",
    icon: "globe",
    control: UNCHECKED_MONO,
  },
  namespaces: { slot: "body", save: "typed", label: "Namespaces", icon: "database", control: UNCHECKED_MONO },
  amqpPort: {
    slot: "body",
    save: "typed",
    label: "AMQP port",
    placeholder: "",
    icon: "server",
    control: { kind: "text", typing: "unchecked", monospace: true, numeric: true },
  },
  apiPath: { slot: "body", save: "typed", label: "API path", icon: "server", control: UNCHECKED_MONO },
  tlsServerName: { slot: "body", save: "typed", label: "TLS server name", icon: "server", control: UNCHECKED_MONO },
  // Saved byte for byte: the provider parses the document and its refusals quote positions in what was written.
  registerMap: {
    slot: "body",
    save: "nonEmpty",
    label: "Register map",
    placeholder: "",
    icon: "database",
    control: { kind: "textarea", rows: 6 },
  },
  // An empty mode is not saved, so the provider's own default, SignAndEncrypt, applies.
  securityMode: {
    slot: "body",
    save: "trimmed",
    label: "Security mode",
    icon: "shield",
    control: { kind: "toggle", choices: ["None", "Sign", "SignAndEncrypt"], unset: "SignAndEncrypt" },
  },
  serverCertificateThumbprint: {
    slot: "body",
    save: "trimmed",
    label: "Server certificate",
    placeholder: "",
    icon: "shield",
    control: UNCHECKED_MONO,
  },
  schema: {
    slot: "body",
    save: "nonEmpty",
    label: "Schema Name",
    placeholder: "default",
    icon: "database",
    control: VERBATIM_MONO,
    note: "Used for unqualified table names in queries and Create Table. Leave empty to qualify names yourself. Run SHOW SCHEMAS to list the catalog's schemas.",
  },
  role: { slot: "body", save: "typed", label: "Role", icon: "shield", control: VERBATIM_MONO },
  authSource: {
    slot: "body",
    save: "nonEmpty",
    label: "Authentication Database",
    placeholder: "admin",
    icon: "key",
    control: { kind: "text", typing: "free", monospace: true },
  },
  apiKeyId: {
    slot: "body",
    save: "nonEmpty",
    label: "API Key ID",
    placeholder: "EWkMhKACjF5eHMlg6Car",
    icon: "key",
    control: { kind: "text", typing: "unfilled", monospace: true },
    group: "apiKey",
  },
  apiKeySecret: {
    slot: "body",
    save: "nonEmpty",
    label: "API Key Secret",
    placeholder: "***",
    icon: "shield",
    control: { kind: "text", typing: "secret", monospace: true },
    group: "apiKey",
  },
  localDataCenter: {
    slot: "body",
    save: "nonEmpty",
    label: "Local Data Center",
    placeholder: "datacenter1",
    icon: "server",
    control: { kind: "text", typing: "free", monospace: true },
  },
  serviceName: {
    slot: "body",
    save: "nonEmpty",
    label: "Service Name",
    placeholder: "ORCL or XEPDB1",
    control: { kind: "text", typing: "free", compact: true },
  },
  instanceName: {
    slot: "body",
    save: "nonEmpty",
    label: "Instance Name",
    placeholder: "SQLEXPRESS",
    control: { kind: "text", typing: "free", compact: true },
  },
} as const satisfies Record<ConnectionField, ConnectionFieldDescriptor>;

/** A field the renderer draws, as opposed to one the dialog's own layout draws. */
export type BodyConnectionField = {
  [F in ConnectionField]: (typeof CONNECTION_FIELD_DESCRIPTOR_ROWS)[F] extends { readonly slot: "body" } ? F : never;
}[ConnectionField];

/** Every connection field's descriptor, keyed by field so a field added to `ConnectionField` fails the typecheck. */
export const CONNECTION_FIELD_DESCRIPTORS: Readonly<Record<ConnectionField, ConnectionFieldDescriptor>> = Object.freeze(
  CONNECTION_FIELD_DESCRIPTOR_ROWS,
);

/** The descriptor of a field the renderer draws, typed as one. */
export function bodyFieldDescriptor(field: BodyConnectionField): BodyFieldDescriptor {
  return CONNECTION_FIELD_DESCRIPTOR_ROWS[field];
}

/**
 * A drawn field whose save writes the `DatabaseConnection` text property of its own name. A field whose name is not
 * such a property is left out of this union, so the list below, typed by it, fails the typecheck.
 */
type FieldWritingItsProperty = {
  [F in BodyConnectionField]: NonNullable<DatabaseConnection[F]> extends string ? F : never;
}[BodyConnectionField];

/**
 * Every field the renderer draws, in the registry's order: the fields the form holds in one record keyed by field,
 * and resets, loads, imports and saves by their descriptors.
 */
export const BODY_CONNECTION_FIELDS: readonly FieldWritingItsProperty[] = Object.freeze(
  (Object.keys(CONNECTION_FIELD_DESCRIPTOR_ROWS) as ConnectionField[]).filter(
    (field): field is BodyConnectionField => CONNECTION_FIELD_DESCRIPTOR_ROWS[field].slot === "body",
  ),
);

const BODY_FIELD_SET: ReadonlySet<string> = new Set(BODY_CONNECTION_FIELDS);

/** Whether a name is a field the renderer draws. */
export function isBodyConnectionField(name: string): name is BodyConnectionField {
  return BODY_FIELD_SET.has(name);
}

/** The value of each field the renderer draws, as the form holds it: text, whatever the control. */
export type BodyFieldValues = { [F in BodyConnectionField]: string };

/** A new form's value of every field the renderer draws, as a fresh record. */
export function initialFieldValues(): BodyFieldValues {
  return Object.fromEntries(
    BODY_CONNECTION_FIELDS.map((field) => [field, bodyFieldDescriptor(field).initial ?? ""]),
  ) as BodyFieldValues;
}

/** What a save writes for a field the engine takes, by the field's `save` rule, or undefined where it writes nothing. */
export function savedFieldValue(field: BodyConnectionField, value: string): string | undefined {
  switch (bodyFieldDescriptor(field).save) {
    case "always":
      return value;
    case "nonEmpty":
      return value === "" ? undefined : value;
    case "typed":
      return value.trim() === "" ? undefined : value;
    case "trimmed":
      return value.trim() === "" ? undefined : value.trim();
  }
}

/** Each type's connection fields as literals, so the compiler can ask what a given type takes. */
const CONNECTION_FIELD_ROWS = {
  postgres: ["host", "port", "user", "password", "database"],
  mysql: ["host", "port", "user", "password", "database"],
  sqlite: ["database"],
  duckdb: ["database"],
  libsql: ["host", "port", "user", "password", "connectionString"],
  mongodb: ["host", "port", "user", "password", "database", "connectionString", "authSource"],
  redis: ["host", "port", "user", "password", "database"],
  oracle: ["host", "port", "user", "password", "database", "serviceName"],
  db2: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
  mssql: ["host", "port", "user", "password", "database", "instanceName"],
  couchbase: ["host", "port", "user", "password", "database", "connectionString"],
  clickhouse: ["host", "port", "user", "password", "database", "connectionString"],
  druid: ["host", "port", "user", "password"],
  elasticsearch: ["host", "port", "user", "password", "apiKeyId", "apiKeySecret"],
  opensearch: ["host", "port", "user", "password"],
  trino: ["host", "port", "user", "password", "database", "schema"],
  cassandra: ["host", "port", "user", "password", "database", "localDataCenter"],
  prometheus: ["host", "port", "user", "password"],
  kafka: ["host", "port", "saslMechanism", "user", "password"],
  etcd: ["host", "port", "user", "password"],
  neo4j: ["host", "port", "user", "password", "database"],
  milvus: ["host", "port", "user", "password", "database"],
  qdrant: ["host", "port", "password"],
  weaviate: ["host", "port", "password"],
  influxdb: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
  influxdb3: ["host", "port", "password", "database", "allowInsecureAuth"],
  oxia: ["host", "port", "password", "database", "dataServers", "allowInsecureAuth"],
  databend: ["host", "port", "user", "password", "database", "warehouse", "allowInsecureAuth"],
  bigquery: ["database", "schema", "password", "location"],
  snowflake: [
    "host",
    "user",
    "authMethod",
    "privateKey",
    "privateKeyPassphrase",
    "password",
    "warehouse",
    "database",
    "schema",
    "role",
  ],
  spark: ["host", "port", "password", "database", "schema"],
  s3: ["host", "port", "user", "password", "database", "region", "allowInsecureAuth"],
  kubernetes: ["host", "port", "password", "database", "namespaces", "apiPath", "tlsServerName"],
  mqtt: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
  firestore: ["database", "schema", "password"],
  rabbitmq: ["host", "port", "user", "password", "amqpPort", "apiPath", "allowInsecureAuth"],
  opcua: ["host", "user", "password", "securityMode", "serverCertificateThumbprint"],
  mtconnect: ["host", "port", "apiPath"],
  modbus: ["host", "port", "registerMap"],
  netconf: ["host", "port", "user", "password", "privateKey", "privateKeyPassphrase", "hostKeyFingerprint"],
  snmp: ["host", "port", "password", "allowInsecureAuth"],
  sparkplug: ["host", "port", "database"],
  libredb: ["database"],
} as const satisfies Record<DatabaseType, readonly ConnectionField[]>;

/** The connection fields one type takes, as a union of literals. */
export type ConnectionFieldOf<T extends DatabaseType> = (typeof CONNECTION_FIELD_ROWS)[T][number];

/** Each type's connection fields, in the order the connection dialog draws them unless the entry says otherwise. */
export const CONNECTION_FIELDS: Readonly<Record<DatabaseType, readonly ConnectionField[]>> =
  Object.freeze(CONNECTION_FIELD_ROWS);

/** The fields only one engine's provider reads, and how a seed of another type that carries one is refused. */
export interface SeedOnlyFields {
  /** The fields only this engine's provider reads, in the order a seed of another type is refused for them. */
  readonly fields: readonly (ConnectionField | SeedOnlyField)[];
  /** "each": one issue per present field at its path; "set": one issue for the whole set at the first present field. */
  readonly kind: "each" | "set";
  readonly refusal: (field: string) => string;
  /** The projection gate's sentence in filterByRoles, or null where the mapper has none. */
  readonly projectionRefusal: ((id: string, type: string) => string) | null;
}

/**
 * Elasticsearch (#708): the API key pair. The seed schema refuses it on any other type-id at load, and `filterByRoles`
 * refuses it again as the mapper's own gate, so a SeedConnection constructed in memory (bypassing zod) cannot be
 * projected as a managed OpenSearch connection whose transport would then drop the pair with no error.
 */
const ELASTICSEARCH_SEED_ONLY_FIELDS: SeedOnlyFields = Object.freeze({
  fields: Object.freeze(["apiKeyId", "apiKeySecret"] as const),
  kind: "set",
  refusal: () =>
    "apiKeyId and apiKeySecret are Elasticsearch-only. OpenSearch (and every other engine) refuses the pair: nothing here has measured whether OpenSearch's security plugin accepts Authorization: ApiKey, so a seed that carries it is rejected rather than listed as a connection that silently falls back to user/password.",
  projectionRefusal: (id: string, type: string) =>
    `Seed connection "${id}" of type "${type}" carries an Elasticsearch API key pair. The pair is Elasticsearch-only; OpenSearch's security plugin has not been measured to accept Authorization: ApiKey, so the seed is refused rather than projected as a connection that silently falls back to user/password.`,
});

/**
 * OPC UA (#1677). Every OPC UA field here is OPC UA's own: on any other engine the provider never reads them, so
 * a seed that carries one would be listed as pinned or as encrypted and be neither. Refused at load by name, as the
 * Elasticsearch API-key pair is.
 *
 * The last three are the OPC UA fields the dialog has no box for, because they are deployment facts: the policy to
 * insist on, and the client certificate and key to present. A server with a trust list of its own has to be given a
 * STABLE client certificate before it will accept a secured channel, and a file path is how a deployment names one -
 * which is the seed file's job and not a text box's. Supplied together or not at all; the provider refuses one
 * without the other.
 */
const OPCUA_SEED_ONLY_FIELDS: SeedOnlyFields = Object.freeze({
  fields: Object.freeze([
    "securityMode",
    "serverCertificateThumbprint",
    "securityPolicyUri",
    "clientCertificatePath",
    "clientPrivateKeyPath",
  ] as const),
  kind: "each",
  refusal: (field: string) =>
    `${field} is OPC UA only: no other engine's provider reads it, so this connection would be listed as carrying it and would not. Remove ${field} from this connection.`,
  projectionRefusal: null,
});

/**
 * NETCONF: the device's SSH host key pin. Only the NETCONF provider reads a top-level `hostKeyFingerprint` (an SSH
 * tunnel's pin is `sshTunnel.hostKeyFingerprint`), so a seed of another type that carries one would be listed as pinned
 * and be nothing of the kind. Refused at load by name, as the OPC UA fields are.
 */
const NETCONF_SEED_ONLY_FIELDS: SeedOnlyFields = Object.freeze({
  fields: Object.freeze(["hostKeyFingerprint"] as const),
  kind: "each",
  refusal: (field: string) =>
    `${field} is NETCONF only: no other engine's provider reads it, so this connection would be listed as carrying it and would not. Remove ${field} from this connection.`,
  projectionRefusal: null,
});

/**
 * Modbus: the register map. Only the Modbus provider reads `registerMap`, so a seed of another type that carries one
 * would be listed as mapped and be nothing of the kind. Refused at load by name, as the NETCONF pin is.
 */
const MODBUS_SEED_ONLY_FIELDS: SeedOnlyFields = Object.freeze({
  fields: Object.freeze(["registerMap"] as const),
  kind: "each",
  refusal: (field: string) =>
    `${field} is Modbus only: no other engine's provider reads it, so this connection would be listed as carrying it and would not. Remove ${field} from this connection.`,
  projectionRefusal: null,
});

/** Each type's seed-only fields, or null where a seed of another type may carry every field this type reads. */
export const SEED_ONLY_FIELDS: Readonly<Record<DatabaseType, SeedOnlyFields | null>> = Object.freeze({
  postgres: null,
  mysql: null,
  sqlite: null,
  duckdb: null,
  libsql: null,
  mongodb: null,
  redis: null,
  oracle: null,
  db2: null,
  mssql: null,
  couchbase: null,
  clickhouse: null,
  druid: null,
  elasticsearch: ELASTICSEARCH_SEED_ONLY_FIELDS,
  opensearch: null,
  trino: null,
  cassandra: null,
  prometheus: null,
  kafka: null,
  etcd: null,
  neo4j: null,
  milvus: null,
  qdrant: null,
  weaviate: null,
  influxdb: null,
  influxdb3: null,
  oxia: null,
  databend: null,
  bigquery: null,
  snowflake: null,
  spark: null,
  s3: null,
  kubernetes: null,
  mqtt: null,
  firestore: null,
  rabbitmq: null,
  opcua: OPCUA_SEED_ONLY_FIELDS,
  mtconnect: null,
  modbus: MODBUS_SEED_ONLY_FIELDS,
  netconf: NETCONF_SEED_ONLY_FIELDS,
  snmp: null,
  sparkplug: null,
  libredb: null,
});
