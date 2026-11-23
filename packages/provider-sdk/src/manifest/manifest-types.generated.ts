// GENERATED FILE - do not edit. Run: bun run manifest:types
//
// Source: packages/provider-sdk/src/manifest/manifest.schema.json, via
// scripts/generate-manifest-types.ts. tests/unit/provider-sdk/manifest-types.test.ts fails on drift.

/** The SHA-256 of the schema file's bytes: `compileManifestValidator` refuses a schema with any other. */
export const MANIFEST_SCHEMA_SHA256 = "546279754fdf88a07aae4918a4903f6988bc3cdcde1a8da02d0e38dded283fb5";

/** A provider package's manifest under provider contract 0.1 (docs/providers/CONTRACT.md). The package's name, version, licence, Node range and entry metadata live in its own package.json, and its publisher is computed from verified provenance, so none of them is declared here. */
export interface ProviderManifest {
  /** The identifier of this schema, for an editor that reads it; never fetched. */
  readonly $schema?: "urn:libredb:provider-manifest:0.1";
  /** The provider contract the manifest was built against, the one this schema serves. */
  readonly contract: "0.1";
  readonly runtime: Runtime;
  /** The engines the package serves, one declaration each. */
  readonly engines: readonly EngineDeclaration[];
  /** The products the package was measured against, one entry per product, each naming an engine the manifest declares. */
  readonly compatibility: readonly CompatibilityEntry[];
  /** Keys of the package's own, which Studio never reads. */
  readonly vendor?: Readonly<Record<string, unknown>>;
}

/** What a host reads first, before it knows which schema applies: the contract the manifest was built against, in the form MAJOR.MINOR. */
export interface Envelope {
  readonly contract: string;
  readonly [key: string]: unknown;
}

/** How the host loads the package into its own process. */
export interface Runtime {
  /** The package-relative POSIX path of the ES module whose default export the loader reads, with no dot segment. */
  readonly entry: string;
  /** The per-platform native packages the package needs, each pinned exactly. */
  readonly native?: readonly NativePackage[];
  /** The environment variables the package reads, each with the reason it reads it. */
  readonly env?: readonly EnvDeclaration[];
}

/** A native package pinned to one version, the platforms it serves and the Node-API version it is built for. */
export interface NativePackage {
  readonly package: string;
  /** An exact version, never a range. */
  readonly version: string;
  readonly targets: readonly NativeTarget[];
  readonly nodeApi: number;
}

/** One platform, in npm's os, cpu and libc vocabulary. */
export interface NativeTarget {
  readonly os: TargetOs;
  readonly cpu: TargetCpu;
  readonly libc?: TargetLibc;
}

export type TargetOs = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";

export type TargetCpu =
  | "arm"
  | "arm64"
  | "ia32"
  | "loong64"
  | "mips"
  | "mipsel"
  | "ppc64"
  | "riscv64"
  | "s390x"
  | "x64";

export type TargetLibc = "glibc" | "musl";

/** One environment variable the package reads, by name, and why. */
export interface EnvDeclaration {
  readonly name: string;
  readonly purpose: string;
}

/** An engine's type-id: a lower-case letter, then up to 31 lower-case letters or digits. */
export type EngineId = string;

/** One engine the package serves. Every fact is required, written as null, false or an empty list where the engine has none, so no fact is left out by omission. */
export interface EngineDeclaration {
  readonly id: EngineId;
  readonly displayName: string;
  readonly location: EngineLocation;
  readonly connection: Connection;
  readonly facets: Facets;
  readonly agent: Agent;
}

/** external: a database the user already runs, which Studio is pointed at. embedded: a store Studio carries and creates itself. */
export type EngineLocation = "external" | "embedded";

/** What a connection to the engine is made of. */
export interface Connection {
  /** The fields the connection dialog draws and a save writes, in the order the VS Code extension prompts in. */
  readonly fields: readonly FieldName[];
  readonly defaults: ConnectionDefaults;
  readonly seedOnly: SeedOnly;
  /** The fields the provider receives only to refuse a value in them by name; none of them is one of the engine's fields. */
  readonly refused: readonly FieldName[];
  readonly connectionString: ConnectionStringOffer;
  readonly tls: FacetOffer;
  readonly sshTunnel: SshTunnelOffered | SshTunnelRefused;
  /** The seed-only fields that name a file on Studio's own host the provider reads. */
  readonly hostPathFields: readonly HostPathField[];
  /** Whether the engine opens a file on Studio's own host as its database. */
  readonly opensLocalFile: boolean;
  /** Whether a connection that names no database reaches every database of the server. */
  readonly serverLevelWithoutDatabase: boolean;
  readonly agentCredential: AgentCredential;
}

/** What the connection dialog fills in when the engine is chosen; a key is absent where the dialog fills in nothing. */
export interface ConnectionDefaults {
  readonly port?: number;
  readonly host?: string;
}

/** The fields only this engine's provider reads, and how a seed of another type that carries one is refused; null where a seed of another type may carry every field this engine reads. */
export type SeedOnly = {
  readonly fields: readonly FieldName[];
  /** each: one refusal per present field. set: one refusal for the whole set. */
  readonly scope: "each" | "set";
  /** The refusal sentence, in which {field} stands for the field refused. */
  readonly refusal: string;
  /** The sentence that refuses a seed connection of another type carrying the fields when it is projected, in which {id} and {type} stand for the connection's id and type; null where the projection has none. */
  readonly projectionRefusal: string | null;
} | null;

/** accepted: whether the provider opens what a connection string names. dialogOffersUri: whether the connection dialog offers a connection string box. */
export interface ConnectionStringOffer {
  readonly accepted: boolean;
  readonly dialogOffersUri: boolean;
}

/** offered: the engine has something to read or do for it. not-offered: it has nothing, so no surface draws it. */
export type FacetOffer = "offered" | "not-offered";

/** The engine's connections may run through an SSH tunnel. */
export interface SshTunnelOffered {
  readonly offered: true;
}

/** The engine's connections never run through an SSH tunnel, and the sentence that refuses one says why. */
export interface SshTunnelRefused {
  readonly offered: false;
  readonly refusal: string;
}

/** The agent credential a seed connection of the engine may carry; null where it carries none. */
export type AgentCredential = {
  readonly form: AgentCredentialForm;
  /** Fields the provider signs in with in preference to the user and password, beside which an agent credential is refused. */
  readonly supersededBy: readonly FieldName[];
} | null;

/** pair: a user and a password. dedicated-pair: a pair whose user differs from the connection's own. secret: a password alone. */
export type AgentCredentialForm = "pair" | "dedicated-pair" | "secret";

/** A connection field, from the contract's closed vocabulary. Its class is the contract's: each name is in exactly one of secretFieldName, identityFieldName and publicFieldName. */
export type FieldName =
  | "host"
  | "port"
  | "connectionString"
  | "allowInsecureAuth"
  | "user"
  | "password"
  | "saslMechanism"
  | "authMethod"
  | "privateKey"
  | "privateKeyPassphrase"
  | "hostKeyFingerprint"
  | "database"
  | "dataServers"
  | "warehouse"
  | "location"
  | "region"
  | "namespaces"
  | "amqpPort"
  | "apiPath"
  | "tlsServerName"
  | "registerMap"
  | "securityMode"
  | "serverCertificateThumbprint"
  | "schema"
  | "role"
  | "authSource"
  | "apiKeyId"
  | "apiKeySecret"
  | "localDataCenter"
  | "serviceName"
  | "instanceName"
  | "securityPolicyUri"
  | "clientCertificatePath"
  | "clientPrivateKeyPath"
  | "agentReadRoots";

/** The field names only a seed file or an embedder's own code sets, which no connection dialog draws. */
export type SeedOnlyFieldName =
  | "securityPolicyUri"
  | "clientCertificatePath"
  | "clientPrivateKeyPath"
  | "agentReadRoots";

/** The secret class: a stored value is encrypted, never sent to a browser, and moves the provider cache key. */
export type SecretFieldName =
  | "connectionString"
  | "password"
  | "privateKey"
  | "privateKeyPassphrase"
  | "apiKeyId"
  | "apiKeySecret";

/** The identity class: another value names another principal or server, so a change of it is a new connection. */
export type IdentityFieldName =
  | "host"
  | "port"
  | "allowInsecureAuth"
  | "user"
  | "saslMechanism"
  | "hostKeyFingerprint"
  | "database"
  | "dataServers"
  | "amqpPort"
  | "apiPath"
  | "tlsServerName"
  | "securityMode"
  | "serverCertificateThumbprint"
  | "authSource"
  | "serviceName"
  | "instanceName"
  | "securityPolicyUri"
  | "clientCertificatePath"
  | "clientPrivateKeyPath";

/** The public class: a value that grants nothing. */
export type PublicFieldName =
  | "authMethod"
  | "warehouse"
  | "location"
  | "region"
  | "namespaces"
  | "registerMap"
  | "schema"
  | "role"
  | "localDataCenter"
  | "agentReadRoots";

/** A field that names a file on Studio's own host, which core admits through its reserved-path refusal before the provider reads it. */
export type HostPathField = "clientCertificatePath" | "clientPrivateKeyPath";

/** What the engine offers beyond its queries. */
export interface Facets {
  readonly monitoring: MonitoringPanels;
  /** The maintenance operations the engine offers before Studio connects. */
  readonly maintenance: readonly MaintenanceOperation[];
  /** The curated operational readings agent mode is offered on the engine. */
  readonly agentReadings: readonly AgentReading[];
}

/** Every monitoring panel, each stated as offered or not, so no panel is offered or withheld by default. */
export interface MonitoringPanels {
  readonly overview: FacetOffer;
  readonly performance: FacetOffer;
  readonly slowQueries: FacetOffer;
  readonly activeSessions: FacetOffer;
  readonly tables: FacetOffer;
  readonly indexes: FacetOffer;
  readonly storage: FacetOffer;
}

export type MaintenanceOperation =
  | "vacuum"
  | "analyze"
  | "reindex"
  | "kill"
  | "optimize"
  | "check"
  | "compact"
  | "defragment"
  | "disarm"
  | "load"
  | "release";

export type AgentReading = "sessions" | "slow-queries" | "table-stats" | "index-stats" | "storage" | "health";

/** What agent mode sends to the engine. */
export interface Agent {
  readonly statementLanguage: StatementLanguage;
}

/** The statement language family agent mode sends, or null where agent mode sends the engine no statement. */
export type StatementLanguage =
  | "sql"
  | "kubectl"
  | "mongo"
  | "libredbkv"
  | "influxql"
  | "weaviateapi"
  | "qdrantapi"
  | "cypher"
  | "milvusrpc"
  | "rediscli"
  | "etcdctl"
  | "oxiacli"
  | "rabbitread"
  | "kafkaread"
  | "s3api"
  | "fsquery"
  | "snmpget"
  | "netconfrpc"
  | "modbusread"
  | "promql"
  | "opcuaread"
  | "mtconnectread"
  | "mqttread"
  | "sparkplugread"
  | null;

/** One product the package was measured against: the engine that serves it, the versions claimed and the versions tested. */
export interface CompatibilityEntry {
  readonly engine: EngineId;
  readonly product: string;
  readonly versions: VersionRange | VersionList | ServiceVersions;
  readonly tested: readonly TestedVersion[];
}

export type ProductVersion = string;

/** Every version from one tested version to another, both included. */
export interface VersionRange {
  readonly kind: "range";
  readonly from: ProductVersion;
  readonly to: ProductVersion;
}

/** The versions named, and no other. */
export interface VersionList {
  readonly kind: "list";
  readonly list: readonly ProductVersion[];
}

/** A hosted service with no version of its own, measured on the date named. */
export interface ServiceVersions {
  readonly kind: "service";
  readonly measured: string;
}

/** A version the package's tests ran against, with the image they ran where one exists. */
export interface TestedVersion {
  readonly version: ProductVersion;
  readonly image?: ImageReference;
}

/** A container image, pinned by the full SHA-256 digest of its manifest. */
export interface ImageReference {
  readonly repository: string;
  readonly digest: string;
}
