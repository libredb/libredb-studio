/**
 * Each connection type's connection fields and the fields only its provider reads, declared as data.
 *
 * `CONNECTION_FIELDS` names the fields the connection dialog draws for a type and `buildConnection` saves, in the
 * order the dialog draws them; `CONNECTION_FORM` (src/lib/db/connection-form.ts) takes each type's array from here by
 * reference, so the list exists once, and the reason a list holds what it does stays beside that type's entry there.
 * `SEED_ONLY_FIELDS` names, per type, the fields a seed of any other type is refused for, with the sentence it is
 * refused with.
 *
 * Pure, browser-safe and UI-free: it imports types only. It is not in src/lib/db-ui-config.ts because that module
 * imports React icon components, which the seed loader must not load, the reason src/lib/db/credential-warnings.ts
 * is a module of its own.
 */
import type { DatabaseType } from "@/lib/types";

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

/** Each type's connection fields, in the order the connection dialog draws them. */
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
  modbus: null,
  netconf: null,
  snmp: null,
  sparkplug: null,
  libredb: null,
});
