// GENERATED FILE - do not edit. Run: bun run manifest:types
//
// Source: packages/provider-sdk/src/manifest/manifest.schema.json, via
// scripts/generate-manifest-types.ts. tests/unit/provider-sdk/manifest-types.test.ts fails on drift.

/** The SHA-256 of the schema file's bytes: `compileManifestValidator` refuses a schema with any other. */
export const MANIFEST_SCHEMA_SHA256 = "2d09cb7757d8ba6f681a5879207e75fca9f04567e139797c604af239592a69ef";

/** A provider package's manifest under provider contract 0.1 (docs/providers/CONTRACT.md). The package's name, version, licence, Node range and entry metadata live in its own package.json, and its publisher is computed from verified provenance, so none of them is declared here. */
export interface ProviderManifest {
  /** The identifier of this schema, for an editor that reads it; never fetched. */
  readonly $schema?: "urn:libredb:provider-manifest:0.1";
  /** The provider contract the manifest was built against, the one this schema serves. */
  readonly contract: "0.1";
  readonly runtime: Runtime;
  readonly calls: Calls;
  /** The engines the package serves, one declaration each, at most 64: a contract limit for a package that serves one provider's engines, which bounds every reading of the list. */
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

/** What the package's code answers beyond the mandatory calls. One implementation serves every engine the package declares, so these are facts of the package, not of an engine; every key is required, written as not-offered or an empty list where the package answers nothing more. */
export interface Calls {
  readonly console: ConsoleCalls;
}

/** The console's calls: execute, which every package answers, and each optional console facet, keyed by the path to its function under the implementation's console. */
export interface ConsoleCalls {
  readonly execute: ExecuteCall;
  readonly cancel: FacetOffer;
  readonly endScope: FacetOffer;
}

/** What the package's console execute does with the optional fields of its request. */
export interface ExecuteCall {
  /** The optional request fields execute honours; the host sends no other. */
  readonly honours: readonly ExecuteRequestField[];
}

/** An optional field of the console execute request. params: bound parameter values. offset: a page that starts past the first row. */
export type ExecuteRequestField = "params" | "offset";

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
  /** The fields the engine refuses by name, each with the sentence core refuses a connection that sets it with, in the order core checks them: core refuses such a connection before any provider is built, so no provider receives one. None of them is one of the engine's fields, and each is listed once. */
  readonly refused: readonly RefusedField[];
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
  readonly dialog: ConnectionDialog;
  /** The URI schemes the dialog's Host box accepts a pasted address in, in the order its refusal names them; empty where it accepts none. */
  readonly hostUriSchemes: readonly HostUriScheme[];
  /** The credentials the engine warns about, read by the connection dialog and at seed load, in the order they are read. */
  readonly credentialWarnings: readonly CredentialWarning[];
  /** The checks the connection dialog runs on a field before Test Connection and Save send anything, at most one rule per field the engine takes; the dialog checks the fields in the order of fields, so the order of this list carries no meaning. */
  readonly fieldRules: readonly FieldRule[];
  /** The function that answers, from the text in the Host box, the sentence the dialog draws in place of the static Host hint while it answers one; null where the engine has none. */
  readonly hostHint: FunctionName | null;
  /** The function that answers the server a Host text names, for telling whether a pasted connection string names the server already in the box; null where the text trimmed and lower-cased is its identity. */
  readonly hostIdentity: FunctionName | null;
  readonly import: ConnectionImport;
}

/** The name of a function the package exports, which the manifest names and never carries, local to its engine: a lower-case letter, then up to 63 letters or digits. */
export type FunctionName = string;

/** The checks on one field: a blank field is refused with required; a field that is not blank must match format, then hold a length within charRange, then pass check. A rule states at least one of them. */
export interface FieldRule {
  readonly field: FieldName;
  /** The sentence a blank field is refused with; null where a blank field passes. */
  readonly required: string | null;
  readonly format: FieldFormat;
  readonly charRange: FieldCharRange;
  /** The function that reads a field that passes format and charRange and answers its refusal sentence, or nothing where it passes; null where the field has none. */
  readonly check: FunctionName | null;
}

/** The pattern a field that is not blank must match, and the sentence it is refused with where it does not; null where the field has none. */
export type FieldFormat = {
  readonly pattern: BoundedPattern;
  readonly sentence: string;
} | null;

/** A regular expression, its source and flags as JavaScript's RegExp reads them, which must compile. A value is tested with RegExp.prototype.test, so a pattern that must match the whole value writes ^ and $ itself. */
export interface BoundedPattern {
  readonly source: string;
  /** No flag, or u alone. */
  readonly flags: "" | "u";
}

/** The length, in characters, a field that is not blank and matches its format must have, both ends included, and the sentence it is refused with otherwise; null where the field has none. */
export type FieldCharRange = {
  readonly min: number;
  readonly max: number;
  readonly sentence: string;
} | null;

/** An import the connection dialog offers for a new connection: the action's label, and the function that reads a pasted text into entries, one of which fills the form, without throwing; null where the dialog offers none. */
export type ConnectionImport = {
  readonly label: string;
  readonly importer: FunctionName;
} | null;

/** A field the engine refuses by name, and the sentence core refuses a connection that sets it with, which names the field and never its value. */
export interface RefusedField {
  readonly field: FieldName;
  readonly refusal: string;
}

/** How the connection dialog presents the engine's fields. Each list holds at most one entry per field, each naming a field the engine takes; a field with no entry keeps the dialog's own word. */
export interface ConnectionDialog {
  /** The order the dialog draws the fields in, the fields left out drawn after them; null where the dialog keeps its own order. */
  readonly order: readonly FieldName[] | null;
  readonly labels: readonly FieldLabel[];
  readonly hints: readonly FieldHint[];
  readonly placeholders: readonly FieldPlaceholder[];
  /** Where each placeable field the engine takes is drawn; every one of them has an entry. */
  readonly placement: readonly FieldPlacementEntry[];
  /** The choices of each select field the engine takes; every one of them has an entry. */
  readonly options: readonly FieldOptions[];
  /** The fields the dialog draws only while another field holds one value; a field hidden by its condition is neither saved nor required. */
  readonly shownWhen: readonly FieldShownWhen[];
  /** The value a connection that leaves a field absent is read as, declared for a field a condition reads. */
  readonly absentValues: readonly FieldAbsentValue[];
}

/** The label the dialog draws for a field in place of its own. */
export interface FieldLabel {
  readonly field: FieldName;
  readonly text: string;
}

/** The sentence the dialog draws under a field. */
export interface FieldHint {
  readonly field: FieldName;
  readonly text: string;
}

/** The example the dialog draws in an empty field in place of its own; the empty string means no example. */
export interface FieldPlaceholder {
  readonly field: FieldName;
  readonly text: string;
}

/** Where the dialog draws one placeable field. */
export interface FieldPlacementEntry {
  readonly field: PlaceableFieldName;
  readonly where: FieldPlacement;
}

/** The fields the dialog draws either in the open or behind Advanced, by the engine's placement. */
export type PlaceableFieldName = "authSource" | "localDataCenter" | "serviceName" | "instanceName";

/** open: drawn with the other fields. advanced: drawn behind Advanced. */
export type FieldPlacement = "open" | "advanced";

/** The fields the dialog draws as a select, whose choices each engine that takes one declares. */
export type SelectFieldName = "saslMechanism" | "authMethod";

/** The choices of one select field, in the order the dialog lists them. */
export interface FieldOptions {
  readonly field: SelectFieldName;
  readonly choices: readonly FieldChoice[];
}

/** One choice of a select: the value saved and the label drawn. */
export interface FieldChoice {
  readonly value: string;
  readonly label: string;
}

/** A field the dialog draws only while its condition holds. */
export interface FieldShownWhen {
  readonly field: FieldName;
  readonly when: FieldCondition;
}

/** One field equals one value, the field's absent value standing for a value the connection leaves absent. */
export interface FieldCondition {
  readonly field: FieldName;
  readonly equals: string;
}

/** The value a connection that leaves the field absent is read as, by the dialog, by core and by the provider. */
export interface FieldAbsentValue {
  readonly field: FieldName;
  readonly value: string;
}

export type HostUriScheme = "http" | "https";

/** A credential the engine warns about. */
export type CredentialWarning = PairWarning | JwtWarning | NoSecretWarning;

/** A published default user and password: the dialog warns when both are typed, and a read-only seed with them is refused. */
export interface PairWarning {
  readonly kind: "pair";
  readonly user: string;
  /** The published default password; the empty string where the default is no password. */
  readonly password: string;
  /** The warning's sentence, which Studio frames with its own words in the dialog and at seed load. */
  readonly message: string;
}

/** A JSON Web Token in the password field, decoded locally: the dialog warns when it declares no expiry or one of the access claims named. */
export interface JwtWarning {
  readonly kind: "jwt";
  readonly noExp: true;
  readonly access: readonly JwtAccessClaim[];
  /** The warning's sentence, which Studio frames with its own words in the dialog and at seed load. */
  readonly message: string;
}

/** m: the token declares manage access. absent: the token declares no access claim at all. */
export type JwtAccessClaim = "m" | "absent";

/** A server that accepts a connection with no password: a read-only seed without one is refused. */
export interface NoSecretWarning {
  readonly kind: "no-secret";
  /** The warning's sentence, which Studio frames with its own words in the dialog and at seed load. */
  readonly message: string;
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

/** What an engine's connection string is. accepted: whether the provider opens what a connection string names. dialogOffersUri: whether the connection dialog offers a connection string box. scheme: the one URI scheme shown for the engine. urlTls: the function that reads the TLS a URL's query carries. paste: how the engine reads a connection string pasted into the dialog's Paste URL box. seedCheck: the function Studio runs on a seed file's connection before any socket. */
export interface ConnectionStringOffer {
  readonly accepted: boolean;
  readonly dialogOffersUri: boolean;
  /** The one URI scheme shown for the engine, lower-case as the parser reads a pasted scheme, of a form the engine's paste reader reads; null where the engine has none. It names no alias the reader also accepts. */
  readonly scheme: string | null;
  /** The function that reads the TLS a URL's query carries into a mode the connection form can hold, or keeps the parameter as written where no mode expresses it, never a weaker mode than the engine's driver applies; only the engine's paste reader calls it. Null where the engine's URL carries no TLS in its query. */
  readonly urlTls: FunctionName | null;
  readonly paste: ConnectionStringPaste;
  /** The function Studio runs when it loads a seed file, on the fields the file writes for a connection of the engine, before any socket: it leaves a field written as a reference unjudged and answers each refusal as a field and a sentence that never quotes the value. Null where the engine is not checked at load. */
  readonly seedCheck: FunctionName | null;
}

/** How an engine reads a pasted connection string; null where the Paste URL box never names the engine. reader: the one function name for the reader's three operations, claims (whether it reads the paste trimmed with its scheme lower-cased), names (whether the paste trimmed and lower-cased whole is a spelling the engine connects with) and parse (the form's fields, or a refusal, for a text claims accepted, and only for such a text). catchAll: whether it claims generic transport schemes other readers may claim on their own hosts, so Studio offers it a paste after every other reader. formats: the forms the Paste URL box names for the engine, each one that parse connects with. */
export type ConnectionStringPaste = {
  readonly reader: FunctionName;
  readonly catchAll: boolean;
  readonly formats: readonly string[];
} | null;

/** offered: the engine, or for a call the package's code, has something to read or do for it. not-offered: it has nothing, so no surface draws it and no call is made. */
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
  /** The maintenance operations the engine offers before Studio connects, each once, so at most as many as the operations there are. */
  readonly maintenance: readonly MaintenanceOperation[];
  /** The curated operational readings agent mode is offered on the engine, each once, so at most as many as the readings there are. */
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

/** The tag of a tagged value, the form a value JSON cannot carry takes when it crosses a JSON boundary: an object whose own keys are exactly $ (the tag) and v (its payload). The value and payload each tag carries are stated by the value codec, @libredb/provider-sdk/values. */
export type ValueTag = "i64" | "bytes" | "ts" | "nf" | "obj";
