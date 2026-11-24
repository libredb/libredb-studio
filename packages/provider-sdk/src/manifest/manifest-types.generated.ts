// GENERATED FILE - do not edit. Run: bun run manifest:types
//
// Source: packages/provider-sdk/src/manifest/manifest.schema.json, via
// scripts/generate-manifest-types.ts. tests/unit/provider-sdk/manifest-types.test.ts fails on drift.

/** The SHA-256 of the schema file's bytes: `compileManifestValidator` refuses a schema with any other. */
export const MANIFEST_SCHEMA_SHA256 = "46eccadcfafb2daa47c76d59303847d7e9b6856fa04edf80d17d550145d39e63";

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
  readonly objects: ObjectsCalls;
  readonly maintenance: MaintenanceCalls;
  readonly monitoring: MonitoringCalls;
}

/** The console's calls: execute, which every package answers, and each optional console facet, keyed by the path to its function under the implementation's console. */
export interface ConsoleCalls {
  readonly execute: ExecuteCall;
  readonly cancel: FacetOffer;
  readonly endScope: FacetOffer;
  readonly transaction: FacetOffer;
}

/** The object facets: each optional call that reads what a connection holds, keyed by the path to its function under the implementation's objects. tree: list a connection's containers and the objects of one kind in one container, count each kind's objects in one container, and describe one object or every object of one kind in one container. */
export interface ObjectsCalls {
  readonly tree: FacetOffer;
}

/** The maintenance facets: each optional call that runs or previews a maintenance operation an engine lists, keyed by the path to its function under the implementation's maintenance. run: run one operation on the object or session it targets, or over the whole database. preview: read what one per-row operation would do to the object its path addresses, before it runs. */
export interface MaintenanceCalls {
  readonly run: FacetOffer;
  readonly preview: FacetOffer;
}

/** The monitoring facets: each optional call that reads what the monitoring dashboard shows, keyed by the path to its function under the implementation's monitoring. panel: read one monitoring panel an engine offers, the panel the request names. poolStats: read the counts of the session's own pool. */
export interface MonitoringCalls {
  readonly panel: FacetOffer;
  readonly poolStats: FacetOffer;
}

/** What the package's console execute does with the optional fields of its request. */
export interface ExecuteCall {
  /** The optional request fields execute honours; the host sends no other. */
  readonly honours: readonly ExecuteRequestField[];
}

/** An optional field of the console execute request. params: bound parameter values. offset: a page that starts past the first row. readOnly: a read-only execute, its row and byte budget and its mode, sent only to a session opened under the read-only policy to be sent statements. */
export type ExecuteRequestField = "params" | "offset" | "readOnly";

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
  readonly editor: Editor;
  readonly sqlText: SqlText;
  readonly sqlWriting: SqlWriting;
  readonly migrationDdl: MigrationDdl;
  readonly sqlGenerators: SqlGenerators;
  readonly policy: PolicyClaims;
  readonly mcp: McpClaims;
  readonly safeguards: Safeguards;
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
  readonly tls: TlsOffer;
  /** Whether the engine's provider is handed the CA certificates of the file NODE_EXTRA_CA_CERTS names, as data: true where its TLS library does not read Node.js's trust store, so the variable never reaches it on its own. Not a claim: no gate reads it, the certificates are the operator's public ones, and a provider that needs them and does not ask fails to verify, never verifies less. */
  readonly readsTrustMaterial: boolean;
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
  readonly connectBudgetMs: ConnectBudget;
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

/** How long the host waits for an open of the engine and for its Test connection, in milliseconds from the open's start: at least 30,000, an SSH tunnel's 20 s handshake bound plus 10 s for the connect, and at most 300,000; null where the engine takes the host's default, DEFAULT_CONNECT_BUDGET_MS, 70,000. */
export type ConnectBudget = number | null;

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

/** A TLS mode a connection asks for. Each means what Studio's published SSLMode type says, the same on every engine that lists it, so no engine's modes are mapped onto another's. An engine lists its modes in this order. */
export type TlsMode = "disable" | "require" | "verify-system" | "verify-ca" | "verify-full";

/** The TLS modes the engine's provider takes. */
export interface TlsOffer {
  /** The modes, each once and in the order of tlsMode; empty where the engine offers no TLS, so no surface draws the TLS panel for it and its provider receives no TLS settings. */
  readonly modes: readonly TlsMode[];
}

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
  /** How each maintenance operation the engine offers is placed, worded and confirmed: one spec for each operation the maintenance list names and for no other, so at most as many as the operations there are. The provider's own statements of its target grammar and wording, never claims: the maintenance routes read the placements only to refuse a request in a form the provider says it does not take, and a typed confirmation only adds a step to the confirmations Studio asks itself. */
  readonly maintenanceSpecs: readonly MaintenanceSpec[];
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

/** One maintenance operation's spec: where its controls are placed, the words they show, the confirmation and preview they ask and the object kinds they run on. A spec places its operation on a row, over the whole database or both; only kill's places it nowhere, since its target is a session the session list names. */
export interface MaintenanceSpec {
  readonly operation: MaintenanceOperation;
  /** The engine's own wording for a control that runs the operation. */
  readonly label: string;
  /** Whether the operation runs on one object a row names: a table, a collection, a keyspace. */
  readonly perEntity: boolean;
  /** Whether the operation runs with no target, over the whole database. */
  readonly global: boolean;
  /** The heading of the operation's own whole-database card, which the card draws with the label on its button and the description as its body; null where the operation stays on the Operations tab's own cards. */
  readonly title: string | null;
  /** The body of the operation's card, of its typed dialog and of its per-row dialog; null where the operation states none. */
  readonly description: string | null;
  readonly confirmation: MaintenanceConfirmation;
  /** Whether a per-row control shows the provider's preview of the operation before it offers the confirm button. */
  readonly preview: boolean;
  /** The object kinds a per-row control offers the operation on, each once; null where it runs on every relation kind, which no empty list states. */
  readonly kinds: readonly ObjectKindId[] | null;
}

/** How a control of the operation is confirmed before it sends anything, beyond the confirmations Studio asks itself. typed: the operation's whole-database card asks for the connection's name, typed exactly. typed-target: a per-row control asks for its object's own name, typed exactly. null where the spec asks neither. */
export type MaintenanceConfirmation = "typed" | "typed-target" | null;

/** An object kind, by the id Studio's object model gives it. */
export type ObjectKindId = string;

export type AgentReading = "sessions" | "slow-queries" | "table-stats" | "index-stats" | "storage" | "health";

/** The statement language agent mode sends to the engine, and the overlay by which agent mode composes on it. */
export interface Agent {
  readonly statementLanguage: StatementLanguage;
  readonly overlay: AgentOverlay;
}

/** How agent mode composes on the engine, member for member as Studio's engine server overlay holds it: null exactly where the engine speaks no statement language. dialect: the members of the engine's family that are bound to its dialect, which only the SQL family has, so null on an engine of any other family. grounding: a named derivation of the family's grounding, Studio's slot groundingOverride, null where the engine keeps its family's. The client view of a dialect and the engine's family are derived, the client view supplied exactly where the server member is, so neither is a member. No member says whether agent mode runs on the engine: the engines agent and MCP statements run on are Studio's agent execution record alone. */
export type AgentOverlay = {
  readonly dialect: SqlDialect;
  /** The function that derives the engine's grounding from its family's, named by its slot, groundingOverride; null where the engine keeps its family's grounding. */
  readonly grounding: FunctionName | null;
} | null;

/** The members of an SQL engine's agent overlay bound to its dialect, each a verified composition or null where the engine composes none, which Studio's overlay writes as unsupported. Every statement a member composes meets Studio's statement fence as a statement the model wrote does, so a member widens what agent mode composes on an engine it already runs on, never where it runs or what the fence admits. */
export type SqlDialect = {
  readonly catalogRead: CatalogRead;
  readonly planEstimate: PlanEstimate;
  readonly profileComposition: ProfileComposition;
  readonly statistics: StatisticsReading;
  readonly catalogCapture: CatalogCapture;
} | null;

/** How the engine reads its catalog, each composed statement sent as a bounded read: one composer per catalog kind, an optional fold of a selector's schema to the name a policy target declares, an optional retry of a refused read, whether the composed statement is a command, and an optional row mapper. Null where the engine composes no catalog read. */
export type CatalogRead = {
  readonly compose: CatalogCompose;
  /** The function that folds a selector's schema to the name a policy target declares, named by its slot, declaredSchema; null where the name is declared as written. */
  readonly declaredSchema: FunctionName | null;
  readonly retry: CatalogRetry;
  /** Whether the engine's catalog answers only to a command rather than to a SELECT, so the statement fence admits each composed catalog statement by identity, on the catalog read alone, still refusing a comment or a word with a side effect. A claim: a request, never a fact Studio believes as declared, granted only as far as Studio's review record of it, the engine's server overlay in Studio's agent overlay registry. Restrictive value: false, under which the composed command meets the fence's ordinary refusal, as the same text written by the model does. */
  readonly commandShaped: boolean;
  /** The function that turns the rows of one kind as the engine answered them into the catalog rows that kind reads as, named by its slot, mapRows; null where the composed statement answers the catalog rows itself. */
  readonly mapRows: FunctionName | null;
} | null;

/** The composer of each catalog kind, each a function of a catalog selector named by its slot: catalogColumns, catalogRelations, catalogIndexes and catalogStatistics. */
export interface CatalogCompose {
  readonly columns: FunctionName;
  readonly relations: FunctionName;
  readonly indexes: FunctionName;
  readonly statistics: FunctionName;
}

/** The one retry a refused catalog read may take, or null where it takes none: matches, named by its slot retryMatches, says whether a database error is the one the retry answers, and rewrite, named by its slot retryRewrite, writes the statement to send instead, which meets the statement fence as any statement does. */
export type CatalogRetry = {
  readonly matches: FunctionName;
  readonly rewrite: FunctionName;
} | null;

/** How the engine asks for its estimating plan: a statement prefix, or a session mode the provider sets around the statement it is given unchanged; null where the engine has no estimating plan. One strip built from every engine's prefix removes a prefix the model wrote on every engine, so a prefix opens with EXPLAIN and holds no word that executes the plan. */
export type PlanEstimate = PlanEstimatePrefix | PlanEstimateSessionMode | null;

/** An estimating plan asked for by a prefix written in front of the statement: EXPLAIN, then words each after one space, up to 128 characters. */
export interface PlanEstimatePrefix {
  readonly kind: "prefix";
  readonly prefix: string;
}

/** An estimating plan asked for by the session mode the provider sets around the statement it is given unchanged. */
export interface PlanEstimateSessionMode {
  readonly kind: "session-mode";
  readonly mode: "estimate-plan";
}

/** How the engine composes a table profile, one aggregate over one scan: the shape tests in the engine's spelling, the type pattern of the columns whose distinct values the engine cannot count, and the type pattern of the columns it cannot count at all, null where it counts every type. Null where the engine composes no profile. */
export type ProfileComposition = {
  readonly shapeTests: ProfileShapeTests;
  readonly incomparableType: ProfileTypePattern;
  readonly uncountableType: ProfileTypePattern | null;
} | null;

/** The shape tests of a table profile, each a function over an already quoted column reference named by its slot: emailShapeTest and digitRunShapeTest. */
export interface ProfileShapeTests {
  readonly email: FunctionName;
  readonly digitRun: FunctionName;
}

/** A pattern a column's type name is tested with anywhere in the name, so it is not anchored: its source and flags as JavaScript's RegExp reads them, which must compile. */
export interface ProfileTypePattern {
  readonly source: string;
  /** No flag, i, u or iu: a flag that remembers where a match stopped is not one a type pattern takes. */
  readonly flags: "" | "i" | "u" | "iu";
}

/** How the engine reads the estimates it already holds about its tables, as the catalog read's statistics kind, so it is stated only beside a catalog read; null where the engine reads none. */
export type StatisticsReading = {
  /** The statement that asks whether the engine holds any statistics, sent as a plain read; null where none is needed. */
  readonly probe: string | null;
  /** The function that builds the estimates from the statistics read's rows, named by its slot, statisticsBuild. */
  readonly build: FunctionName;
  /** The engine's absolute limit, said once ahead of the estimates; null where it has none to say. */
  readonly limitNote: string | null;
} | null;

/** How the engine's grounding capture reads its catalog, through its catalog read, so it is stated only beside one; null where the provider describes its own schema instead. */
export type CatalogCapture = {
  /** The catalog kinds the capture reads, in statement order, each once. */
  readonly kinds: readonly CatalogKind[];
  /** The function that builds the captured tables from the rows of each kind, named by its slot, captureBuild. */
  readonly build: FunctionName;
  /** The engine's own word for what a relation is, each mapped onto the object kind the provider declares, in the order Studio's overlay holds them; each word once. */
  readonly kindWords: readonly CaptureKindWord[];
} | null;

/** Which inventory a catalog read asks for. */
export type CatalogKind = "columns" | "relations" | "indexes" | "statistics";

/** One word the engine's catalog answers for what a relation is, a letter, then up to 63 letters, digits or underscores, and the object kind the provider declares for it. */
export interface CaptureKindWord {
  readonly word: string;
  readonly kind: ObjectKindId;
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

/** The editor facts of the engine that are data: the keyword its open transaction is committed with, the consent card's deadline, the fence tags naming it, the explain format of its plans, its query dialect and the language its tabs are written and rendered in. The SQL text facts are sqlText, the SQL writing facts sqlWriting, the migration DDL facts migrationDdl and the SQL generator forms sqlGenerators. */
export interface Editor {
  /** The one word that keeps an open transaction on the engine, which the notice Studio shows when a statement left a transaction open and it was rolled back names: a letter, then up to 31 letters, digits or underscores. */
  readonly commitKeyword: string;
  readonly consentDeadline: ConsentDeadline;
  /** The fence tags, other than the engine's own id, that name the engine: a fenced block a model writes under one of them holds a statement for this engine. The engine's id is always a fence tag naming it, so it is never listed here, and a generic fence tag names no engine, so it is never listed either. */
  readonly fenceAliases: readonly FenceTag[];
  readonly explainFormat: ExplainFormat;
  readonly dialect: QueryDialectRow;
  readonly language: EditorLanguageFacts;
}

/** The chip and the sentence the agent's consent card shows for an engine whose long read ends differently from the others, or null where the engine has none. chip: the label in the card's bounds row. sentence: the paragraph under the card's box. */
export type ConsentDeadline = {
  readonly chip: string;
  readonly sentence: string;
} | null;

/** A markdown fence tag as Studio reads it, lower-cased: a lower-case letter, then up to 31 lower-case letters or digits, the form of an engine id. */
export type FenceTag = string;

/** The fence tags of a query language several engines speak: a block under one of them holds a query and names no engine, so no engine declares one as an alias. */
export type GenericFenceTag = "sql" | "cql";

/** The format of the engine's query plans, one of Studio's explain strategies, as the provider declares it for a connection it has not connected; Studio reads a plan with that format's strategy. Null where the engine offers no explain. */
export type ExplainFormat =
  | "postgres-json"
  | "postgres-text"
  | "postgres-text-analyze"
  | "mysql-json"
  | "mysql-text"
  | "sqlite-queryplan"
  | "couchbase-json"
  | "clickhouse-json"
  | "druid-native"
  | "trino-json"
  | "duckdb-json"
  | "databend-text"
  | "bigquery-dryrun"
  | "snowflake-json"
  | "firestore-explain"
  | "spark-text"
  | null;

/** A query dialect Studio's editor reads: a grammar of JSON or of a command line that is neither MongoDB's JSON nor SQL. */
export type QueryDialect =
  | "libredb"
  | "redis"
  | "kafka"
  | "etcd"
  | "milvus"
  | "qdrant"
  | "weaviate"
  | "oxia"
  | "s3"
  | "mqtt"
  | "firestore"
  | "rabbitmq"
  | "kubectl"
  | "opcua"
  | "mtconnect"
  | "modbus"
  | "netconf"
  | "snmp"
  | "sparkplug";

/** The engine's query dialect and what the editor offers for it, or null where the engine declares no dialect. name: the dialect, under whose name the editor opens the engine's tabs. offersColumnProfiling: whether Profile is offered. offersCodeGeneration: whether the code generator is offered. offersCountQuery: whether Generate Count Query is offered. offersSqlExport: whether the result export menu offers SQL INSERT statements and CREATE TABLE DDL. historyMask: the flags whose values query history never keeps. */
export type QueryDialectRow = {
  readonly name: QueryDialect;
  readonly offersColumnProfiling: boolean;
  readonly offersCodeGeneration: boolean;
  readonly offersCountQuery: boolean;
  readonly offersSqlExport: boolean;
  readonly historyMask: HistoryMask;
} | null;

/** The language the engine's query tabs are written and rendered in. queryLanguage: the query language the engine speaks; an engine with no dialect opens its tabs under that language's tab type (sql for sql, mongodb for json, and promql, cypher and influxql for their own), an engine with a dialect under the dialect's name, so no tab type is stated. monacoId: the Monaco language the tabs render in, one of Studio's editor languages. accent: that language's accent. console: whether the language is a console dialect, registered under its Monaco id, which is also its dialect id, so no second id is stated. */
export interface EditorLanguageFacts {
  readonly queryLanguage: QueryLanguage;
  readonly monacoId: MonacoLanguageId;
  readonly accent: EditorAccent;
  readonly console: boolean;
}

/** A query language Studio's editor reads: SQL, JSON, PromQL, Cypher or InfluxQL. */
export type QueryLanguage = "sql" | "json" | "promql" | "cypher" | "influxql";

/** A Monaco language Studio's query editor renders a tab in, each with Studio's own registration, completion and formatting code until Studio's browser catalog reads them. graph-cypher and not cypher, which Monaco's own bundle registers. */
export type MonacoLanguageId =
  | "sql"
  | "json"
  | "libredb"
  | "redis"
  | "promql"
  | "etcd"
  | "oxia"
  | "s3"
  | "kubectl"
  | "firestore"
  | "graph-cypher"
  | "influxql"
  | "milvus"
  | "qdrant"
  | "weaviate"
  | "mtconnect";

/** The border class an agent answer's statement block takes in the language, up to 32 characters: border-hue-, one hue of Studio's palette in lower-case letters that is none of the three status hues (amber, rose, emerald), optionally -alt, then /40. */
export type EditorAccent = string;

/** The command-line flags whose values query history never keeps, each once, or null where history keeps a statement as typed. */
export type HistoryMask = {
  readonly credentialFlags: readonly CredentialFlag[];
} | null;

/** A long command-line option: two hyphens, a lower-case letter, then up to 62 lower-case letters, digits or hyphens. */
export type CredentialFlag = string;

/** The engine's SQL text facts: whether its statement text is SQL, the grammar Studio's SQL readers read a statement's structure with, how a statement is redacted before the query event log keeps it, the words the update target reader needs beyond the grammar, and how completion quotes and reads qualified names. */
export interface SqlText {
  /** Whether the engine's statement text is SQL. False is a claim that loosens the confirmation gate, which the gate counts only where Studio's review record lists it, and every other reader reads it as declared. */
  readonly readsSqlText: boolean;
  readonly grammar: GrammarFacts;
  readonly redaction: StatementRedaction;
  readonly updateTarget: UpdateTargetWords;
  readonly completion: CompletionReaders;
}

/** The engine's SQL grammar facts, one member per fact of the SDK's SqlGrammar, whose doc comments give each fact's rationale. A fact the SqlGrammar type may leave out is written at the reading its absence has, so a form the engine does not have is false or an empty list. */
export interface GrammarFacts {
  readonly hash: HashRule;
  readonly bracket: BracketRule;
  readonly blockComment: BlockCommentRule;
  /** Whether q'...' opens a string literal, Oracle's alternate quoting. */
  readonly alternateQuoting: boolean;
  /** Whether // opens a line comment. */
  readonly doubleSlashComment: boolean;
  /** Whether a backslash always escapes the next character inside '...' and "...", under every session setting. */
  readonly backslashAlwaysEscapes: boolean;
  /** Whether '''...''' and """...""" are string literals that run to the next unescaped triple; false where the engine has no such form. */
  readonly tripleQuotedStrings: boolean;
  /** Whether a backslash escapes the next character inside a backtick identifier; false where only a doubled backtick escapes. */
  readonly backtickBackslashEscapes: boolean;
  /** Whether a tagged run, $tag$ ... $tag$, is a string literal; true where the engine has the form, the reading every engine had before the fact existed. False: the $ that would open a tagged run is code, and the untagged $$ ... $$ is still a dollar string. */
  readonly dollarTags: boolean;
  /** Whether a backslash escapes the next character inside "..."; null where the quote takes the reading backslashAlwaysEscapes gives both quotes, which is a third reading where backslashAlwaysEscapes is false. */
  readonly doubleQuoteBackslashEscapes: boolean | null;
  /** Whether a backslash escapes the next character inside '...'; null where the quote takes the reading backslashAlwaysEscapes gives both quotes, which is a third reading where backslashAlwaysEscapes is false. */
  readonly singleQuoteBackslashEscapes: boolean | null;
  /** Whether r'...', R'...', r"..." and R"..." are string literals that take no escapes; false where the engine has no such form. */
  readonly rawStrings: boolean;
  /** Whether /*+ opens an optimizer hint the engine lexes as code rather than a block comment; false where it opens a block comment. */
  readonly hintsAreCode: boolean;
  /** Whether a line comment continues onto the next line when a backslash stands immediately before the line feed that would end it; false where it never does. */
  readonly lineCommentBackslashContinues: boolean;
  /** Whether a carriage return ends a line comment as a line feed does; false where a carriage return is comment text. */
  readonly lineCommentEndsAtCarriageReturn: boolean;
  readonly script: ScriptFacts;
  /** The clauses that must follow the row bound on the engine, each a pattern matching one such clause at the very end of a statement, in the order the limiter strips them; empty where the engine has none. */
  readonly trailingLimitClauses: readonly ClausePattern[];
  /** The values other than a digit run the engine accepts as a LIMIT or FETCH count and as an OFFSET, each spelled as a statement writes it, with no whitespace; empty where the engine accepts only digits. */
  readonly nonNumericRowBounds: readonly string[];
  /** Keyword sequences that ask for a confirmation when they operate a statement, beside the shared dangerous keywords; empty where the engine adds none. */
  readonly confirmForms: readonly KeywordSequence[];
  /** Forms that ask for a confirmation wherever they appear in a statement's code; empty where the engine adds none. */
  readonly confirmCodeForms: readonly CodeForm[];
  /** Keyword sequences that ask only when a code word also appears in the statement's code after them; empty where the engine adds none. */
  readonly confirmFormsWhen: readonly ConditionalForm[];
  /** Keyword sequences led by a shared dangerous keyword that do not ask on the engine, each a claim that loosens the confirmation gate, which the gate counts only where Studio's review record lists it; empty where every shared keyword asks. */
  readonly confirmExemptForms: readonly KeywordSequence[];
  readonly formatterLanguage: FormatterLanguage;
  readonly completionWords: CompletionWords;
  /** Session configuration keys whose SET or RESET asks for a confirmation, compared without case, an entry ending in . matching every key under it; a list, even an empty one, also makes a RESET with no key ask. Null where no SET or RESET asks. */
  readonly confirmConfigKeys: readonly string[] | null;
  /** Whether EXPLAIN ANALYZE executes the explained statement; false where EXPLAIN only plans. */
  readonly explainExecutesWithAnalyze: boolean;
}

/** What a # opens. comment: a line comment, always. code: never a comment. comment-unless-operator: the compatibility default, a comment unless the next character makes a PostgreSQL jsonb or geometric operator. */
export type HashRule = "comment" | "code" | "comment-unless-operator";

/** What a [...] run is. quoted-identifier: a name that does not nest. subscript: an array literal or a subscript, which nests. */
export type BracketRule = "quoted-identifier" | "subscript";

/** Where a block comment ends when a second /* is written inside it. flat: at the first closer, whatever is inside. nesting: an inner /* opens another comment, so the run ends where the depth returns to zero. */
export type BlockCommentRule = "flat" | "nesting";

/** How a script is cut into what the engine receives, beyond the ; the span rules find. separatorLine: the token a line holding only it ends the statement in progress with, never sent, or null where the engine has none. terminatedStatements: the operative keywords whose statement keeps its own terminating ;, empty where every statement drops it. */
export interface ScriptFacts {
  readonly blocks: ProcedureBodies;
  readonly separatorLine: "GO" | "/" | null;
  readonly unit: ScriptUnit;
  readonly terminatedStatements: readonly SqlKeyword[];
}

/** Which statements carry a procedural body, inside which a ; ends a body statement. none: no statement does. trigger-body: CREATE TRIGGER ... BEGIN ... END is the one statement with a body. pl-sql: an anonymous block and every stored PL/SQL unit. */
export type ProcedureBodies = "none" | "trigger-body" | "pl-sql";

/** What one request to the engine carries. statement: one statement. batch: everything between two separator lines, sent whole. */
export type ScriptUnit = "statement" | "batch";

/** A pattern matching one clause that must follow the row bound, at the very end of a statement: its source and flags as JavaScript's RegExp reads them, which must compile. The source opens with \s+, so a host that anchors it behind a character that is not whitespace starts a match only where a whitespace run starts, and closes with \s*$, so it matches only at the end. */
export interface ClausePattern {
  readonly source: string;
  /** i, so the clause's words match in any case, or iu. */
  readonly flags: "i" | "iu";
}

/** One SQL keyword as the readers compare it, upper-cased: an upper-case letter, then up to 63 upper-case letters, digits or underscores. */
export type SqlKeyword = string;

/** A sequence of one to 16 keywords, read in order with whitespace or comments between them. */
export type KeywordSequence = readonly SqlKeyword[];

/** A form a confirmation code form looks for: a keyword sequence, an identifier prefix, a word a literal follows, a word a routine body follows, a quoted name called as a function, a word whose parenthesised run names the function called, or a dollar-quoted run. */
export type CodeForm =
  | KeywordSequence
  | CodeFormPrefix
  | CodeFormWordThenLiteral
  | CodeFormWordThenBody
  | CodeFormQuotedCall
  | CodeFormComputedCall
  | CodeFormDollarQuoted;

/** The start of an identifier: an upper-case letter, then up to 63 upper-case letters, digits, underscores or dollar signs. */
export interface CodeFormPrefix {
  readonly prefix: string;
}

/** A word whose next code, past whitespace and comments, is a string literal. */
export interface CodeFormWordThenLiteral {
  readonly wordThenLiteral: SqlKeyword;
}

/** A word whose next code is a routine body, a string literal or a dollar-quoted run. */
export interface CodeFormWordThenBody {
  readonly wordThenBody: SqlKeyword;
}

/** A closed quoted name whose text is the word, compared without case, that a ( follows. */
export interface CodeFormQuotedCall {
  readonly quotedCall: SqlKeyword;
}

/** A word followed by a parenthesised run and then a (, a call whose function name the run computes. */
export interface CodeFormComputedCall {
  readonly computedCall: SqlKeyword;
}

/** A dollar-quoted run, $$...$$ or $tag$...$tag$, a body the gate does not read. */
export interface CodeFormDollarQuoted {
  readonly dollarQuoted: true;
}

/** A keyword sequence that asks only when the code word when also appears in the statement's code after it. */
export interface ConditionalForm {
  readonly form: KeywordSequence;
  readonly when: SqlKeyword;
}

/** The sql-formatter language the editor's Format uses for the engine; postgresql where the engine declares none, the language every engine formatted with before an engine declared one. */
export type FormatterLanguage = "postgresql" | "snowflake";

/** The keywords and functions the editor's completion offers on the engine beside the shared lists, a function inserted as a call; both lists empty where the engine adds none. A keyword is upper-case words separated by one space. */
export interface CompletionWords {
  readonly keywords: readonly string[];
  readonly functions: readonly SqlKeyword[];
}

/** How a statement is redacted before the query event log keeps it. */
export type StatementRedaction = SqlTextRedaction | CommandRedaction | NoRedaction;

/** SQL text: the statement's literals are replaced, and only a closed name in the engine's identifier quote is kept. */
export interface SqlTextRedaction {
  readonly kind: "sql";
  readonly nameQuote: NameQuote;
}

/** A command language: the named pure reader answers, from the statement's text, the text the query event log keeps. */
export interface CommandRedaction {
  readonly kind: "command";
  readonly reader: FunctionName;
}

/** Nothing of the statement's text is kept. */
export interface NoRedaction {
  readonly kind: "none";
}

/** The character that opens the engine's quoted identifier, whose closed names redaction keeps; null where the engine has none. */
export type NameQuote = '"' | "`" | "[" | null;

/** The facts the update target reader needs beyond the grammar. dashCommentNeedsSeparator: whether -- opens a comment only when a space or a control character follows it. extraQueryOpeners: the words beside the shared set that open a query. extraSetOperators: the words beside the shared set that join two queries. Each word list is empty where the engine adds none. */
export interface UpdateTargetWords {
  readonly dashCommentNeedsSeparator: boolean;
  readonly extraQueryOpeners: readonly SqlKeyword[];
  readonly extraSetOperators: readonly SqlKeyword[];
}

/** How completion quotes and reads qualified names. */
export interface CompletionReaders {
  /** The pure function that quotes one name segment, used instead of the connection's quoting; null where the connection's quoting is used. */
  readonly formatSegment: FunctionName | null;
  /** The pure function that reads, from the text up to a dot, the qualifier before the dot when it is quoted; null where the engine has no such reading. */
  readonly readQuotedQualifier: FunctionName | null;
}

/** The engine's SQL writing facts: how a generated statement spells a literal, a name, a bind and a temporal literal for the engine, what its inline edit and its result export read, and how a document insert is written where its console text is a request. One member per member of Studio's SQL writing row, each function named by the slot it fills. escapeLiteral: the pure function that writes a text as the engine's whole quoted literal. unescapeLiteral: the pure function that reads a whole literal back to its text. quoteIdentifier: the pure function that quotes a name so its closing quote cannot end it. binaryLiteral, under export, writes bytes as a literal the engine accepts. */
export interface SqlWriting {
  readonly escapeLiteral: FunctionName;
  readonly unescapeLiteral: FunctionName;
  readonly quoteIdentifier: FunctionName;
  /** The pure function that writes the bind placeholder for a 1-based position; null where the engine quotes each value instead of binding it. */
  readonly placeholder: FunctionName | null;
  /** The pure function that writes a date or timestamp text as the engine's literal of that kind, or answers none to quote it; null where every such text is quoted. */
  readonly temporalLiteral: FunctionName | null;
  readonly inlineEdit: InlineEditFacts;
  readonly export: ExportFacts;
  /** The pure function that writes the request inserting documents at an address, for an engine whose console text is a request rather than a statement; null where the test data generator writes an INSERT. */
  readonly insertDocuments: FunctionName | null;
}

/** What the inline edit reads for the engine: the type names that make a key column date-time, exact decimal and float64, each read against the first word of the column's declared type, lower-cased and with its wrappers off. */
export interface InlineEditFacts {
  readonly instantTypeNames: KeyTypeNames;
  readonly exactDecimalTypeNames: KeyTypeNames;
  readonly float64TypeNames: Float64TypeNames;
  /** The pure function that writes the SET right-hand side of one edit that is not NULL, or answers none to bind the text unchanged; null where every edit binds its text unchanged. */
  readonly boundEdit: FunctionName | null;
}

/** Type names a key column's declared type is compared with, each once; an empty list where no name makes a key column of that kind. */
export type KeyTypeNames = readonly KeyTypeName[];

/** One type name as the inline edit compares it: a lower-case letter, then up to 63 lower-case letters, digits or underscores, since the inline edit reads only the lower-cased first word of a declared type. */
export type KeyTypeName = string;

/** The type names that make a key column float64, or all where every key column of the engine is float64. */
export type Float64TypeNames = KeyTypeNames | "all";

/** What the result export writes for the engine: the CREATE TABLE type of each inferred kind, the declared type names kept as they are, the bare names written with a spelling of their own, the patterns a declared type is read with, the literal NaN and the infinities are written as, and whether an INSERT takes VALUES or SELECT. A hook the engine lacks is null. */
export interface ExportFacts {
  readonly ddlTypes: DdlTypeSpellings;
  /** The bare declared type names the engine stands behind, written through as they are; empty where every bare name is re-spelled from its family. */
  readonly standsAlone: readonly DeclaredTypeName[];
  /** The bare declared type names the engine narrows below the value its driver hands back, each with the spelling written instead, each name once; empty where the engine narrows none. */
  readonly bareSpelling: readonly BareSpellingEntry[];
  readonly typeVocabulary: TypeVocabulary;
  readonly binaryLiteral: FunctionName;
  readonly nonFinite: NonFiniteLiterals;
  readonly insertForm: InsertForm;
  /** The pure function that rewrites a declared type before a CREATE TABLE takes it; null where no type is rewritten. */
  readonly rewriteDeclared: FunctionName | null;
  /** The pure function that answers a column's type from its declared type and its first value, or none to leave it; null where no type is read from a value. */
  readonly declareFromSample: FunctionName | null;
  /** The pure function that writes a cell from its column's declared type, or none to leave it to the generic writer; null where the generic writer writes every cell. */
  readonly typedLiteral: FunctionName | null;
  /** The pure function that prepares one literal writer per column from the declared types; null where no column has a writer of its own. */
  readonly columnWriters: FunctionName | null;
  readonly createTableKey: CreateTableKey;
}

/** How the engine spells each inferred kind of column in a CREATE TABLE. */
export interface DdlTypeSpellings {
  readonly text: SqlTypeSpelling;
  readonly integer: SqlTypeSpelling;
  readonly numeric: SqlTypeSpelling;
  readonly boolean: SqlTypeSpelling;
  readonly timestamp: SqlTypeSpelling;
  readonly binary: SqlTypeSpelling;
}

/** One SQL type as a CREATE TABLE writes it, verbatim, up to 64 characters: words separated by one space, the first opening with a letter, each of letters, digits or underscores, then at most one parenthesized argument list with its commas inside it, each argument such words, then words, so it fills one column's type, never adds a column and never ends its line or its statement. A type nested two deep is not admitted yet. */
export type SqlTypeSpelling = string;

/** A bare declared type name as the export compares it: lower-case words separated by one space, each a lower-case letter, then lower-case letters, digits or underscores, since the export reads a declared type trimmed, lower-cased and with each run of whitespace one space. */
export type DeclaredTypeName = string;

/** A bare declared type name and the spelling the export writes in its place. */
export interface BareSpellingEntry {
  readonly name: DeclaredTypeName;
  readonly spelling: SqlTypeSpelling;
}

/** The patterns the export reads a declared type with for the engine. bareTypeFamily: the bare names whose parameters the result does not carry, grouped by the inferred kind each is re-spelled from. floatType: a declared type that holds a binary float, tested against the trimmed type. exactNumericType: an exact numeric type that can hold an infinity, tested against the trimmed type. numericWrapper: a wrapper that changes nothing about whether a column holds numbers, whose one capturing group is the wrapped type. */
export interface TypeVocabulary {
  readonly bareTypeFamily: TypeFamilies;
  readonly floatType: TypePattern;
  readonly exactNumericType: TypePattern;
  readonly numericWrapper: TypePattern;
}

/** The bare declared type names of each inferred kind, each name under one kind only; an empty list where no name is of that kind. */
export interface TypeFamilies {
  readonly text: DeclaredTypeNames;
  readonly integer: DeclaredTypeNames;
  readonly numeric: DeclaredTypeNames;
  readonly boolean: DeclaredTypeNames;
  readonly timestamp: DeclaredTypeNames;
  readonly binary: DeclaredTypeNames;
}

/** Bare declared type names, each once. */
export type DeclaredTypeNames = readonly DeclaredTypeName[];

/** A pattern a declared type is read with: its source and flags as JavaScript's RegExp reads them, which must compile. The source opens with ^ and closes with $, since it is tested against a whole type. */
export interface TypePattern {
  readonly source: string;
  /** No flag, i, u or iu: a flag that remembers where a match stopped, or that changes where $ matches, is not one a type pattern takes. */
  readonly flags: "" | "i" | "u" | "iu";
}

/** How the export writes NaN and the infinities into a float column, each as a literal the engine reads back; NULL where the engine cannot store the value. */
export interface NonFiniteLiterals {
  readonly NaN: NonFiniteLiteral;
  readonly Infinity: NonFiniteLiteral;
  readonly "-Infinity": NonFiniteLiteral;
}

/** A literal an INSERT writes verbatim: printable ASCII, 1 to 64 characters, with no space at either end and no line break. */
export type NonFiniteLiteral = string;

/** How an INSERT is written. values: INSERT INTO t (...) VALUES (...). select: INSERT INTO t (...) SELECT .... */
export type InsertForm = "values" | "select";

/** A key a CREATE TABLE needs that a result cannot supply: the note written above the statement, and the pure function, clause, that writes the key's definition from the quoted column names; null where the engine takes a table without one. */
export type CreateTableKey = {
  readonly note: CommentLines;
  readonly clause: FunctionName;
} | null;

/** Whole SQL comment lines, each -- and a space, then text with no line break, then a line feed, up to 1024 characters in all, so the text written above a statement never becomes one. */
export type CommentLines = string;

/** What the schema diff's migration writes for the engine, in one of two forms: refused, where the engine writes no table DDL and the migration is one comment line saying why, or written, with its transaction wrapper, its CREATE TABLE form and a statement writer for each change. One member per member of Studio's migration DDL row in that form, each function named by the slot it fills. */
export type MigrationDdl = MigrationDdlRefused | MigrationDdlWritten;

/** Migration DDL of an engine that writes no table DDL: the one comment line the migration holds in place of any statement, no transaction wrapper, and the reasons the line gives. */
export interface MigrationDdlRefused {
  readonly tableDdl: "refused";
  readonly refusal: MigrationRefusal;
  /** Always null: an engine that writes no table DDL has nothing to wrap. */
  readonly transactionWrapper: null;
  readonly reasons: DdlReasons;
}

/** Migration DDL of an engine that writes table DDL: its transaction wrapper or null, its CREATE TABLE form, and the pure function that writes each statement from names the migration has already quoted. columnDef: one column's definition. createIndex and dropIndex: an index's CREATE and DROP. addForeignKey and dropForeignKey: a foreign key added to or dropped from a table. addColumn, dropColumn and modifyColumn: a column added, dropped or changed, the last as one statement or several. dropTable: a table dropped. reasons: every refusal sentence the writers print. */
export interface MigrationDdlWritten {
  readonly tableDdl: "written";
  readonly transactionWrapper: TransactionWrapper;
  readonly createTable: CreateTable;
  readonly columnDef: FunctionName;
  readonly createIndex: FunctionName;
  readonly dropIndex: FunctionName;
  readonly addForeignKey: FunctionName;
  readonly dropForeignKey: FunctionName;
  readonly addColumn: FunctionName;
  readonly dropColumn: FunctionName;
  readonly modifyColumn: FunctionName;
  readonly dropTable: FunctionName;
  readonly reasons: DdlReasons;
}

/** The statements the migration writes on a line of their own before its first statement and after its last; null where the migration is not wrapped in a transaction. */
export type TransactionWrapper = {
  readonly begin: WrapperStatement;
  readonly commit: WrapperStatement;
} | null;

/** One statement of a transaction wrapper, up to 64 characters: words of letters separated by one space, ending in its one semicolon, so it is one statement on its line and never a second. */
export type WrapperStatement = string;

/** How the migration writes a CREATE TABLE for the engine: written, with the pure functions that write the primary key and a foreign key from quoted names, each inside the column list or as a statement after it, or refused, with the pure function that writes the line in its place for the quoted table. */
export type CreateTable = CreateTableRefused | CreateTableWritten;

/** A CREATE TABLE the engine refuses: createTableRefusal names the pure function that writes the line in its place for the quoted table. */
export interface CreateTableRefused {
  readonly kind: "refused";
  readonly createTableRefusal: FunctionName;
}

/** A CREATE TABLE the engine writes: primaryKey names the pure function that writes the primary key from the quoted key columns, and foreignKey the one that writes a foreign key of the quoted table. */
export interface CreateTableWritten {
  readonly kind: "written";
  readonly primaryKey: FunctionName;
  readonly foreignKey: FunctionName;
}

/** The whole migration after its header for an engine that writes no table DDL: one SQL comment line, -- and a space, then text with no line break, up to 1024 characters, so it is never a statement. */
export type MigrationRefusal = string;

/** Every refusal sentence the engine's migration DDL can print, each once, in the row's order; an empty list where it prints none. */
export type DdlReasons = readonly DdlReason[];

/** One refusal sentence, 1 to 1024 characters with no line break, since every sentence a writer prints is printed inside a comment line. */
export type DdlReason = string;

/** What an SQL engine writes apart from Studio's shared SQL forms, or null where it writes the shared forms, quotes a name as its declared identifier quoting or Studio's default says, and counts with COUNT(*). One member per member of Studio's SQL generator row, each function named by the slot it fills. quote: the pure function that quotes a name for the engine, leaving it bare where it round-trips bare and quoting is not forced. */
export type SqlGenerators = {
  readonly quote: FunctionName;
  /** The pure function that writes the tree click's statement on the quoted address; null where the shared form stands. */
  readonly table: FunctionName | null;
  /** The pure function that writes Generate Query's statement on the quoted address and its columns; null where the shared form stands. */
  readonly select: FunctionName | null;
  /** The pure function that writes Generate Query's statement on the quoted address and its projected column list; null where the shared form stands. */
  readonly selectList: FunctionName | null;
  readonly countExpression: CountExpression;
} | null;

/** The count Generate Count Query writes for the engine, COUNT(*) where the engine's is the shared one: one aggregate call over every row, a letter, then letters, digits or underscores, then (*), up to 64 characters, so it fills one expression of the statement Studio writes and never adds a clause or a statement. */
export type CountExpression = string;

/** What the engine asks of the gates Studio decides before or around a provider. Every member is a claim: a request, never a fact Studio believes as declared. Studio grants a request only as far as its own review record of the claim, or an operator's audited grant, allows, and reads a claim with neither at its restrictive value, named at the end of each member's description. */
export interface PolicyClaims {
  readonly writeReach: WriteReachClaim;
  /** Whether the engine's provider opens its handle under a file-access posture, opening with external file access off where the caller's is denied, so a denied handle and a full-reach one never share a cached provider or a borrowed handle. Restrictive value: true. */
  readonly readsFileAccessPosture: boolean;
  /** The sentence a connection whose file access is denied is refused with before anything is opened, where the provider cannot confine that access; null where a denied handle opens confined. Restrictive value: a refusal, so every caller whose file access is denied is refused. */
  readonly deniedFileAccessRefusal: string | null;
  /** Whether the engine keeps one handle per database file in a process, so every user of a connection is served the one provider instead of a provider of their own. Restrictive value: false, each user keeping a provider of their own. */
  readonly singleWriterFile: boolean;
  /** Whether agent mode and MCP read the engine only beneath read roots a seed declares, refusing a connection that declares none. Restrictive value: true. */
  readonly readRootsRequired: boolean;
  readonly agentCredentialForm: AgentCredentialFormClaim;
  readonly maskingExemptColumns: MaskingExemption;
}

/** The form of the agent credential every agent acquisition of the engine takes. pair: a user and a password, both required. token: a password alone, sent as the bearer token instead of the connection's own, with no user. service-account-key: a password alone holding a service-account key, from which the provider mints its own access token, with no user. dedicated-user: a user other than the connection's own and that user's password, both required. none: the engine has no principal to sign an agent in as, so every agent credential is refused. The forms are unordered: a host reads a request that differs from Studio's record at its restrictive value. Restrictive value: none. */
export type AgentCredentialFormClaim = "pair" | "token" | "service-account-key" | "dedicated-user" | "none";

/** The result columns no masking rule of Studio masks on the engine, and why; null where the engine exempts no column. Restrictive value: null, so every column the masking rules match stays masked. */
export type MaskingExemption = {
  /** A regular expression over a result column's name, compiled with no flag, that matches whole names only: it opens with ^, closes with an unescaped $ and keeps every alternative inside a group. */
  readonly column: string;
  /** Why the columns the pattern matches hold no value a masking rule protects. */
  readonly reason: string;
} | null;

/** What Studio's code can write on the engine. none: no code of the provider can send a write on any write path. guarded: every write path it has is refused by a named gate while read-only mode holds. open: at least one path sends a write no Studio gate refuses. Studio keeps a connection's read-only mode only where the reach is not open, so no manifest states read-only enforcement. Restrictive value: open, under which read-only mode is refused, ordered open, guarded, none from the most restrictive. */
export type WriteReachClaim = "none" | "guarded" | "open";

/** What the engine asks of the gates Studio's MCP server decides. Every member is a claim: a request, never a fact Studio believes as declared. Studio grants a request only as far as its own review record of the claim, or an operator's audited grant, allows, and reads a claim with neither at its restrictive value, named at the end of each member's description. The engines agent and MCP statements run on are Studio's own record, which no manifest states. */
export interface McpClaims {
  /** Whether a connection of the engine may be exposed to MCP clients at all. Restrictive value: false. */
  readonly exposable: boolean;
  /** Whether an MCP client may run a statement on the engine, beside the metadata tools exposable opens. Restrictive value: false. */
  readonly statementRead: boolean;
  /** Whether reading the engine's metadata changes state the engine keeps, though it writes no data, so the metadata tool is not marked read-only. Restrictive value: true. */
  readonly metadataReadChangesState: boolean;
  /** Whether MCP reads the engine only under an agent credential of the seed's own, refusing a connection that has none. Restrictive value: true. */
  readonly agentCredentialRequired: boolean;
}

/** What the engine's provider states its own code does: the reach of each write path, the answer of its metadata-only read and the result columns its inline editor refuses. Every member is a fact the provider declares, never a request: no gate of Studio reads it, so none is a claim, and Studio's census reads each back to the provider's own declaration. A review reads them as the evidence of the policy claims. */
export interface Safeguards {
  readonly writePaths: WritePaths;
  /** Each operation the engine's metadata-only read permits, in the provider's order, with the columns its answer holds; null where the provider answers its machine surfaces as it reads, which no empty list states. */
  readonly metadataOnly: readonly MetadataOnlyOperation[] | null;
  readonly inlineEditRefusedColumns: InlineEditRefusal;
}

/** What the provider's code can send on each of Studio's four write paths: the query editor, object edit, maintenance and transactions. A provider that states no path is written open on every path, the reading Studio gives that absence. The policy claim writeReach is their summary: open where any path is open, else guarded where any is gated, else none. */
export interface WritePaths {
  readonly editor: WritePathEvidence;
  readonly objectEdit: WritePathEvidence;
  readonly maintenance: WritePathEvidence;
  readonly transaction: WritePathEvidence;
}

/** One write path's reach: absent, gated or open. */
export type WritePathEvidence = WritePathAbsent | WritePathGated | WritePathOpen;

/** The provider has no code on the path that can send a write. On the editor path it names the structural proof that keeps it so; elsewhere the proof is null where it names none. */
export interface WritePathAbsent {
  readonly reach: "absent";
  readonly proof: WritePathProof | null;
}

/** Provider code refuses every write on the path while read-only mode holds, naming the mode, before any request, and the gate names that code. */
export interface WritePathGated {
  readonly reach: "gated";
  readonly gate: WritePathProof;
}

/** The path sends a write no Studio gate refuses. */
export interface WritePathOpen {
  readonly reach: "open";
}

/** The export that keeps a write path's answer: its module by its path relative to the root of the package declaring the engine, under src/ with no dot segment and ending in .ts, and the export's name. */
export interface WritePathProof {
  readonly module: string;
  readonly symbol: string;
}

/** One operation a metadata-only read permits, by the name the provider gives it, and the columns its answer holds, in the answer's order, each named once. */
export interface MetadataOnlyOperation {
  readonly operation: string;
  readonly columns: readonly MetadataOnlyColumn[];
}

/** One column of a metadata-only answer and the kind of fact it holds. */
export interface MetadataOnlyColumn {
  readonly column: string;
  readonly kind: MetadataOnlyKind;
}

/** name: a name the store keeps for an object of its own, printable, 1 to 512 characters. count: a non-negative safe integer. flag: true or false. */
export type MetadataOnlyKind = "name" | "count" | "flag";

/** The result columns the engine's inline editor refuses to edit, by their type, and the reason a refused cell shows; null where it refuses none by type. */
export type InlineEditRefusal = {
  /** A regular expression over a result column's type name, compiled with no flag. */
  readonly type: string;
  readonly reason: string;
} | null;

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
