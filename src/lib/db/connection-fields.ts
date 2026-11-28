/**
 * Each connection type's connection fields and the fields only its provider reads, declared as data.
 *
 * `CONNECTION_FIELDS` names the fields the connection dialog draws for a type and `buildConnection` saves, in the
 * order the dialog draws them unless the type's form entry declares a `dialogOrder`; `CONNECTION_FORM` (src/lib/db/connection-form.ts) takes each type's array from here by
 * reference, so the list exists once, and the reason a list holds what it does stays beside that type's entry there.
 * `SEED_ONLY_FIELDS` names, per type, the fields a seed of any other type is refused for, with the sentence it is
 * refused with; with `CONNECTION_FIELDS` it declares what a provider is built from (`providerFields` in
 * src/lib/db/provider-connection.ts). `REFUSED_CONNECTION_FIELDS` maps, per type, each field its engine refuses by name
 * to the sentence core refuses it with before any provider is built; no provider receives one.
 *
 * Those three are authored in each engine's declaration (`connection.fields`, `connection.seedOnly` and
 * `connection.refused` in src/lib/db/engine-declarations/<type-id>.json) and projected into
 * `./engine-catalog/connection.generated.ts` by scripts/generate-engine-catalog.ts (docs/providers/CONTRACT.md, clause
 * M-71), which this module reads; the reason a row holds what it does is in the engine's provider doc. None of them is
 * a claim, and `SeedAgentCredential` below is the shape of Studio's grant of the agent credential claim, which
 * src/lib/db/claim-grants.ts reads from the grant register.
 *
 * `CONNECTION_FIELD_DESCRIPTORS` says how the dialog draws each field, as data its one renderer reads.
 *
 * Pure, browser-safe and UI-free: it imports types and the generated records only. It is not in
 * src/lib/db-ui-config.ts because that module imports React icon components, which the seed loader must not load, the
 * reason src/lib/db/credential-warnings.ts is a module of its own.
 */
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import {
  BUNDLED_CONNECTION_FIELDS,
  BUNDLED_REFUSED_FIELDS,
  BUNDLED_SEED_ONLY,
} from "./engine-catalog/connection.generated";

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
/**
 * The fields a seed file may carry that no connection dialog draws: a deployment fact, named by a file path or a URI,
 * or an OPC UA seed's read roots. Only the operator's seed file or an embedder's own code sets one:
 * `resolveServedConnection` (src/lib/seed/resolve-connection.ts) refuses by name a connection a browser or a client
 * supplies inline that sets one, and the managed connection list (src/app/api/connections/managed/route.ts) never sends
 * one to the browser.
 */
export const SEED_ONLY_FIELD_NAMES = Object.freeze([
  "securityPolicyUri",
  "clientCertificatePath",
  "clientPrivateKeyPath",
  "agentReadRoots",
] as const);
/** A field a seed file may carry that no connection dialog draws (`SEED_ONLY_FIELD_NAMES`). */
export type SeedOnlyField = (typeof SEED_ONLY_FIELD_NAMES)[number];

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

/**
 * Each type's connection fields, in the order the connection dialog draws them unless the entry says otherwise: each
 * engine's `connection.fields`, projected from its declaration. The generated record keeps each row's literals, so a
 * declared field outside `ConnectionField` fails the typecheck here.
 */
export const CONNECTION_FIELDS: Readonly<Record<DatabaseType, readonly ConnectionField[]>> = BUNDLED_CONNECTION_FIELDS;

/** The fields only one engine's provider reads, and how a seed of another type that carries one is refused. */
export interface SeedOnlyFields {
  /** The fields only this engine's provider reads, in the order a seed of another type is refused for them. */
  readonly fields: readonly (ConnectionField | SeedOnlyField)[];
  /** "each": one issue per present field at its path; "set": one issue for the whole set at the first present field. */
  readonly kind: "each" | "set";
  /** The refusal's template, in which `{field}` stands for the field refused; `seedOnlyRefusal` renders it. */
  readonly refusal: string;
  /**
   * The projection gate's template in filterByRoles, in which `{id}` and `{type}` stand for the connection's id and
   * type, or null where the mapper has none; `seedOnlyProjectionRefusal` renders it.
   */
  readonly projectionRefusal: string | null;
}

/**
 * Each type's seed-only fields, or null where a seed of another type may carry every field this type reads: each
 * engine's `connection.seedOnly`, projected from its declaration, its `scope` read as `kind`.
 */
export const SEED_ONLY_FIELDS: Readonly<Record<DatabaseType, SeedOnlyFields | null>> = BUNDLED_SEED_ONLY;

/** The refusal template's one placeholder. */
const FIELD_PLACEHOLDER = /\{field\}/g;

/** The projection refusal template's two placeholders. */
const ID_TYPE_PLACEHOLDER = /\{(id|type)\}/g;

/**
 * The sentence a seed of another type carrying `field` is refused with: `row`'s template with each `{field}` replaced,
 * in one pass, by `field` as it is, so a field holding a placeholder or a replacement pattern is written as given.
 */
export function seedOnlyRefusal(row: SeedOnlyFields, field: string): string {
  return row.refusal.replaceAll(FIELD_PLACEHOLDER, () => field);
}

/**
 * The sentence the projection gate refuses the seed connection `id` of type `type` with: `row`'s template with each
 * `{id}` and `{type}` replaced, in one pass, by its value as it is.
 *
 * @throws {Error} When `row` declares no projection refusal, naming its fields.
 */
export function seedOnlyProjectionRefusal(row: SeedOnlyFields, id: string, type: string): string {
  if (row.projectionRefusal === null) {
    throw new Error(`The seed-only fields ${row.fields.join(", ")} declare no projection refusal`);
  }
  return row.projectionRefusal.replaceAll(ID_TYPE_PLACEHOLDER, (_, name: string) => (name === "id" ? id : type));
}

/** The sentence one refused field is refused with, keyed by the field. */
export type RefusedFieldRow = Readonly<Partial<Record<ConnectionField, string>>>;

/**
 * The fields each type's engine does not take and refuses by name, each mapped to the sentence it is refused with:
 * fields its dialog never draws, which a seed, a stored record or an embedder could still set (FND-2 slice 6c).
 * `createDatabaseProvider` refuses a connection that sets one (any value but `undefined`, `null` and `""`) with that
 * sentence, before any provider is built (`assertOpenable` in src/lib/db/open-check.ts, which reads the row from the
 * engine's record as `connection.refused`), while `readProviderDeclarations`, which never connects, drops it; no
 * provider receives one (`providerFields`). Each sentence is quoted in its engine's provider doc. A field is listed in
 * the order it is checked: each engine's `connection.refused`, projected from its declaration in its list order.
 */
export const REFUSED_CONNECTION_FIELDS: Readonly<Record<DatabaseType, RefusedFieldRow>> = BUNDLED_REFUSED_FIELDS;

/**
 * What an agent credential on a seed of one engine is: `agentUser` and `agentPassword`, the principal every agent
 * execution profile and every MCP call on that seed signs in as. It is a coarser view of the engine's granted
 * `policy.agentCredentialForm` (src/lib/db/claim-grants.ts), which the factory checks again at open: "pair" is a user
 * and a password together, the form a null granted agent credential form takes; "dedicated-pair" is the same with a
 * user other than the connection's own; and "secret" is `agentPassword` alone, a bearer token or a service-account
 * key. An engine whose grant is null takes none.
 */
export interface SeedAgentCredential {
  readonly form: "pair" | "dedicated-pair" | "secret";
  /** Fields the provider signs in with in preference to user and password; an agent credential beside one is refused. */
  readonly supersededBy: readonly (keyof DatabaseConnection)[];
}
