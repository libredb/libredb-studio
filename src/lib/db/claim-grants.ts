/**
 * Studio's grant of each policy, MCP, connection, agent mode and SQL text claim an engine declaration requests
 * (docs/providers/CONTRACT.md, clauses M-54, M-82 and M-83): the one module that reads a request,
 * `BUNDLED_CLAIM_REQUESTS` and a legacy engine's SQL text in `BUNDLED_SQL_TEXT`, and Studio's review of each claim for
 * each engine, and the module every gate reads in their place.
 *
 * A claim is a request, never a fact Studio believes as declared (clause M-52). So each claim is granted as the more
 * restrictive of the engine's request and the row of Studio's record, and at the claim's restrictive value (clause
 * M-53) where the record holds no row, one rule per claim shape:
 * - `writeReach`, ordered `open`, `guarded`, `none` from the most restrictive: the more restrictive of the two, `open`
 *   where no row exists. An engine's `readOnlyEnforced` is true exactly where the granted write reach is not `open`.
 * - `readsFileAccessPosture`, `readRootsRequired`, `metadataReadChangesState` and `agentCredentialRequired`,
 *   restrictive when true: true where the request or the row is, or no row exists.
 * - `exposable` and `statementRead`, restrictive when false: true only where the request and the row both are. An
 *   engine read as requiring an agent credential whose granted seed agent credential is null, or whose granted agent
 *   credential form is `none`, which refuses every agent acquisition, is closed to MCP whatever its exposure request
 *   and row (clause M-55).
 * - `deniedFileAccessRefusal`, restrictive as a refusal: a request that refuses keeps its own sentence, a request of
 *   null takes the row's refusal, and takes `UNGRANTED_DENIED_FILE_ACCESS_SENTENCE`, core's own, where no row exists.
 * - `singleWriterFile`, where neither value is restrictive, since a second read-write handle on a single-writer file
 *   and one handle shared between users both overreach: the row where the request equals it, false where no row exists;
 *   any other request leaves the engine refused at every open with `UNGRANTED_SINGLE_WRITER_FILE_SENTENCE`, which the
 *   engine's `ungrantedRefusals` holds and the open check's `assertClaimsGranted` raises before anything is touched.
 * - `agentCredentialForm`, unordered: the row where the request equals it, the record's null row read as `pair`, and
 *   `none` otherwise or where no row exists. The granted table keeps the record's vocabulary, null for the pair.
 * - `maskingExemptColumns`, unordered: the row where the request equals it, column pattern and reason, and null
 *   otherwise or where no row exists.
 * - `connection.opensLocalFile`, restrictive when true: true where the request or the row is, or no row exists.
 * - `connection.hostPathFields`, a set a gate admits: the union of the request and the row, the row's fields first and
 *   the request's others after them in its order, the row itself where the request adds nothing; where no row exists,
 *   the union of the request and every host path field among the engine's seed-only fields, the claim's restrictive
 *   value, which `grantEngineClaims` reads from the seed-only rows it is handed.
 * - `connection.serverLevelWithoutDatabase`, read per gate, since its two gates refuse at opposite values: at
 *   governance admission, which never grants a definition with no database of such an engine, restrictive when true,
 *   true where the request or the row is or no row exists; at the choice of database, which honours a caller's choice
 *   only on such an engine, restrictive when false, true only where the request and the row both are.
 * - `connection.sshTunnel`, restrictive as a refusal: a request that refuses keeps its own sentence, an offered request
 *   takes the row's sentence, or null where the row offers one, and takes `UNGRANTED_SSH_TUNNEL_SENTENCE`, core's own,
 *   where no row exists. The granted table keeps the record's vocabulary, the sentence or null.
 * - `connection.agentCredential`, unordered: the row where the request equals it, form and superseding fields in order,
 *   and null otherwise or where no row exists.
 * - `agent.statementLanguage`, unordered: the row where the request equals it, and null, agent mode sending the engine
 *   no statement, otherwise or where no row exists.
 * - `facets.agentReadings`, a set a gate offers: the intersection of the request and the row, in the row's order,
 *   always a fresh frozen list, and the empty list where no row exists.
 * - The SQL text claims hold only for the grammar the row reviewed them with: the grammar is granted as reviewed,
 *   `reviewedGrammar`, only where the digest the request carries, `grammarSha256` (the SHA-256 of the grammar's
 *   canonical text, ./grammar-digest), is the row's `grammarSha256`, and under any other grammar, or where the row
 *   states none or no row exists, every SQL text claim is read at its restrictive value.
 * - `sqlText.redaction`, unordered: the row's where the grammar is reviewed and the request equals it, kind, name quote
 *   and command reader's name, always a fresh frozen copy, and `none`, under which the query event log keeps nothing
 *   of a statement's text, otherwise. The register refuses a package row granting a `command` redaction, so a
 *   package's `command` request is read as `none`.
 * - `sqlText.readsSqlText`, restrictive when true: false only where the grammar is reviewed and the request and the
 *   row both are false.
 * - `sqlText.grammar.confirmExemptForms`, a set the confirmation gate exempts: the requested forms the row lists, each
 *   compared word by word upper-cased as the gate compares a form, in the request's order, always a fresh frozen list
 *   with each form frozen, and the empty list under a grammar the row did not review.
 * - `decidesAlone`, which no declaration requests, a statement vocabulary row's own flag being its request: the row's
 *   where the grammar is reviewed, and false otherwise.
 * A record's row is looked up as an own property, so a key on the prototype chain is no row. A request value outside
 * its claim's vocabulary is refused by name, naming the claim and the engine, never read at a default; a write reach
 * or host path fields value of a register row outside it is refused naming Studio's record, the claim and the engine; an
 * agent credential row naming a superseding field that is not a text field a connection form draws is refused by
 * `legacyAgentCredentials` when the row is read, naming the engine and the field; and every other value is the
 * register's own, validated against its schema when it was read.
 *
 * Studio's review of each policy, MCP and connection claim, of the agent mode claims `agent.statementLanguage` and
 * `facets.agentReadings` and of the SQL text claims for an engine is the engine's row of the grant register,
 * `@libredb/grant-register` (clause M-54): one call, `grantEngineClaims`, grants every claim of one engine against its
 * row, or at each claim's restrictive value where no row exists, for a legacy engine and a package's alike. A legacy
 * engine's SQL text request is its bundled `readsSqlText` and exempt forms with its row's redaction and grammar digest
 * (`legacySqlTextRequest`); a package engine's is its admitted declaration's, with the digest of its grammar computed
 * on the server by the server catalog's composer, so no module the browser loads hashes a grammar. A legacy engine's row is its legacy
 * row, keyed by `LEGACY_KEY` and the engine id: the register is read once, when this module loads, with
 * `SHIPPED_DATABASE_TYPES`, the legacy adapter's served set, and `legacyGrantRows` refuses by name a served engine the
 * register holds no legacy row for, so no served engine is read at a restrictive value by omission. A row's review
 * notes say why it holds its value. The rows are hand-reviewed data, never a projection of the declarations (clauses
 * M-52, M-53 and M-83). A register its schema or its code rules refuse fails this module's load, in the browser as on
 * the server. Studio's review of the two host facts no declaration requests, whether an engine's connections serve one
 * session and whether agent mode executes statements on it, is the same legacy rows' `servesOneSession` and
 * `agentExecution`, which each engine's grants carry, and the second is also answered as a list,
 * `GRANTED_AGENT_EXECUTION_ENGINES`; no claim is granted from them. tests/unit/db/claim-record-readers.test.ts holds that no other module of Studio's source
 * loads the register, and that none but the claim projection and the listed readers of an engine record's grant reads
 * a member named `agentReadings`, and
 * tests/unit/db/engine-declaration-readers.test.ts that no other module reads a request. For every engine Studio ships
 * each request is its review row, so each granted table equals that row there.
 *
 * A built provider's own declaration of its write reach, its file-access posture, a single-writer file, its agent
 * credential form, its masking exemption or its catalog sessions reaches no gate (clause M-57): each gate reads the
 * grant of the connection's engine record, `EngineRecord["grants"]` in ./server-catalog, which this module's
 * `grantEngineClaims` answers, and `catalogChoice` (./catalog-scope) honours the catalog sessions a provider declares
 * only where the record's grant at the choice of database, `serverLevelAtCatalogChoice`, holds.
 *
 * Each legacy engine's grants are granted once, when this module loads, from its bundled request and its legacy row,
 * and read through `legacyEngineGrants`, which every legacy record holds; the tables below are cut from them for the
 * browser modules that still read a table, until M7. The server catalog's composer grants an admitted provider
 * package's engine through the same `grantEngineClaims`. The module holds literals, generated data and the register's
 * rows only, and the register's reader compiles no code, so the browser's readers, the read-only marker, the
 * connection form and the agent rail, load it as they load the records.
 */
import type {
  AgentCredentialFormClaim,
  AgentReading,
  McpClaims,
  NameQuote,
  PolicyClaims,
  StatementLanguage,
  StatementRedaction,
} from "@libredb/provider-sdk/manifest";
import {
  type GrantRegister,
  LEGACY_KEY,
  type RegisterGrants,
  type RegisterRedaction,
  type RegisterRow,
  readGrantRegister,
} from "@libredb/grant-register";
import type { DatabaseConnection, DatabaseType, HostPathField } from "@/lib/types";
import { SHIPPED_DATABASE_TYPES } from "./compatibility";
import { BODY_CONNECTION_FIELDS, SEED_ONLY_FIELDS, type SeedAgentCredential } from "./connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "./engine-catalog/claims.generated";
import { BUNDLED_SQL_TEXT } from "./engine-catalog/sql-text.generated";
import type { AgentClaims, ClaimRequestEntry, ConnectionClaims, FacetClaims } from "./engine-catalog/projection";
import type { AgentCredentialForm, ProviderCapabilities } from "./types";
import type { WriteReach } from "./write-reach";

/**
 * The statement language bundled engine `T` requests, `agent.statementLanguage` of its generated claim request, as its
 * literal type. It carries no value to any gate: the agent packs' engine types read it. For every bundled engine the
 * request equals the engine's legacy row in the grant register (tests/unit/db/engine-declarations.test.ts), so the
 * type is the engine's granted statement language.
 */
export type StatementLanguageRequest<T extends DatabaseType> =
  (typeof BUNDLED_CLAIM_REQUESTS)[T]["agent"]["statementLanguage"];

/** A masking exemption as Studio's record holds it: a column pattern and a reason, or null. */
type MaskingExemption = NonNullable<ProviderCapabilities["maskingExemptColumns"]> | null;

/** One record of Studio's, keyed by engine id; an id it holds no row for is read at the claim's restrictive value. */
type Rows<T> = Readonly<Record<string, T>>;

/**
 * Studio's review of each policy, MCP, connection and agent mode claim for one engine, keyed by the member requesting
 * it, each a record of that engine's row alone, or of none: the shape the rules below read.
 */
interface ClaimRecords {
  readonly writeReach: Rows<WriteReach>;
  readonly readsFileAccessPosture: Rows<boolean>;
  readonly deniedFileAccessRefusal: Rows<string | null>;
  readonly singleWriterFile: Rows<boolean>;
  readonly readRootsRequired: Rows<boolean>;
  readonly agentCredentialForm: Rows<AgentCredentialForm | null>;
  readonly maskingExemptColumns: Rows<MaskingExemption>;
  readonly exposable: Rows<boolean>;
  readonly statementRead: Rows<boolean>;
  readonly metadataReadChangesState: Rows<boolean>;
  readonly agentCredentialRequired: Rows<boolean>;
  readonly opensLocalFile: Rows<boolean>;
  readonly hostPathFields: Rows<readonly HostPathField[]>;
  readonly serverLevelWithoutDatabase: Rows<boolean>;
  /** The sentence a tunnel that is on is refused with, or null where the engine takes one. */
  readonly sshTunnel: Rows<string | null>;
  readonly agentCredential: Rows<SeedAgentCredential | null>;
  readonly statementLanguage: Rows<StatementLanguage>;
  readonly agentReadings: Rows<readonly AgentReading[]>;
}

/** An engine's seed-only fields as `grantEngineClaims` reads them, or null where it has none. */
type SeedOnlyRow = { readonly fields: readonly string[] } | null;

/** Studio's grant of each claim for every engine of a set, each table keyed by the set's engines. */
interface ClaimGrants<K extends string> {
  readonly writeReach: Readonly<Record<K, WriteReach>>;
  readonly readsFileAccessPosture: Readonly<Record<K, boolean>>;
  readonly deniedFileAccessRefusal: Readonly<Record<K, string | null>>;
  readonly singleWriterFile: Readonly<Record<K, boolean>>;
  readonly readRootsRequired: Readonly<Record<K, boolean>>;
  readonly agentCredentialForm: Readonly<Record<K, AgentCredentialForm | null>>;
  readonly maskingExemptColumns: Readonly<Record<K, MaskingExemption>>;
  readonly exposable: Readonly<Record<K, boolean>>;
  readonly statementRead: Readonly<Record<K, boolean>>;
  readonly metadataReadChangesState: Readonly<Record<K, boolean>>;
  readonly agentCredentialRequired: Readonly<Record<K, boolean>>;
  /** True exactly where the granted write reach is not `open`. */
  readonly readOnlyEnforced: Readonly<Record<K, boolean>>;
  /** The sentence every open of the engine is refused with, or null where its claims leave none. */
  readonly ungrantedRefusals: Readonly<Record<K, string | null>>;
  readonly opensLocalFile: Readonly<Record<K, boolean>>;
  readonly hostPathFields: Readonly<Record<K, readonly HostPathField[]>>;
  /** `connection.serverLevelWithoutDatabase` as governance admission reads it. */
  readonly serverLevelAtAdmission: Readonly<Record<K, boolean>>;
  /** `connection.serverLevelWithoutDatabase` as the choice of database reads it. */
  readonly serverLevelAtCatalogChoice: Readonly<Record<K, boolean>>;
  readonly sshTunnel: Readonly<Record<K, string | null>>;
  readonly agentCredential: Readonly<Record<K, SeedAgentCredential | null>>;
  readonly statementLanguage: Readonly<Record<K, StatementLanguage>>;
  readonly agentReadings: Readonly<Record<K, readonly AgentReading[]>>;
}

/**
 * The legacy row of each engine of `engines` in `register`, keyed by engine in `engines`' order: the register's own
 * rows, deep-frozen by its reader, in a frozen record.
 *
 * @throws {Error} Naming the engine, for an engine of `engines` the register holds no legacy row for: such an engine is
 * never read at a restrictive value, since the legacy adapter serves it and its review is missing.
 */
export function legacyGrantRows(
  register: GrantRegister,
  engines: readonly string[],
): Readonly<Record<string, RegisterRow>> {
  return Object.freeze(
    Object.fromEntries(
      engines.map((engine) => {
        const row = register.rowFor({ legacy: LEGACY_KEY, engine });
        if (row === null) {
          throw new Error(`the grant register holds no legacy row for ${engine}, an engine the legacy adapter serves`);
        }
        return [engine, row];
      }),
    ),
  );
}

/**
 * The grant register Studio reads, once, when this module loads, with `SHIPPED_DATABASE_TYPES`, the legacy adapter's
 * served set: its `LEGACY_ENGINE_IDS` is defined as it. The boot hands it to the server catalog's composer
 * (src/lib/provider-host/boot.ts), which looks up each admitted package engine's row in it, so no other module of
 * Studio's source loads the register.
 */
export const STUDIO_GRANT_REGISTER: GrantRegister = readGrantRegister(SHIPPED_DATABASE_TYPES);

/** The grant register's legacy rows of every engine Studio ships. */
const LEGACY_GRANT_ROWS = legacyGrantRows(STUDIO_GRANT_REGISTER, SHIPPED_DATABASE_TYPES);

/**
 * The agent credential of each engine of `rows`, the grants of a register row of either key, legacy or package, in
 * `rows`' order, its superseding fields narrowed to `fields`: a null grant stays null, and every other is a fresh
 * frozen form and list. The register holds a superseding field as plain text, so each is found by name in `fields` and
 * taken from there, never cast. Studio hands it `BODY_CONNECTION_FIELDS`, the text fields a connection form draws, and
 * never an engine's own row of `CONNECTION_FIELDS`, so reading a row reads no engine's connection row; that each legacy
 * row's superseding fields are among its engine's own connection fields is held by the agent credential census,
 * tests/unit/db/agent-credential-capability.test.ts.
 *
 * @throws {Error} Naming the engine and the field, for a superseding field `fields` does not hold: a misspelt field
 * would otherwise never equal a request, closing the engine to an agent credential silently.
 */
export function legacyAgentCredentials(
  rows: Readonly<Record<string, RegisterGrants>>,
  fields: readonly (keyof DatabaseConnection)[],
): Rows<SeedAgentCredential | null> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(rows).map(([engine, grants]) => {
        const credential = grants.agentCredential;
        if (credential === null) return [engine, null];
        const supersededBy = credential.supersededBy.map((name) => {
          const field = fields.find((candidate) => candidate === name);
          if (field === undefined) {
            throw new Error(
              `the grant register's row for ${engine} names ${JSON.stringify(name)} among the fields superseding its agent credential, which is not a text field a connection form draws`,
            );
          }
          return field;
        });
        return [engine, Object.freeze({ form: credential.form, supersededBy: Object.freeze(supersededBy) })];
      }),
    ),
  );
}

/**
 * The host path fields a declaration may name, the schema's `hostPathField` enum, in its order: the vocabulary of
 * `connection.hostPathFields`.
 */
export const HOST_PATH_FIELD_NAMES: readonly HostPathField[] = Object.freeze([
  "clientCertificatePath",
  "clientPrivateKeyPath",
]);

/**
 * The statement languages a declaration may request, the schema's `statementLanguage` enum but its null, in its order:
 * the vocabulary of `agent.statementLanguage`.
 */
export const STATEMENT_LANGUAGE_NAMES: readonly NonNullable<StatementLanguage>[] = Object.freeze([
  "sql",
  "kubectl",
  "mongo",
  "libredbkv",
  "influxql",
  "weaviateapi",
  "qdrantapi",
  "cypher",
  "milvusrpc",
  "rediscli",
  "etcdctl",
  "oxiacli",
  "rabbitread",
  "kafkaread",
  "s3api",
  "fsquery",
  "snmpget",
  "netconfrpc",
  "modbusread",
  "promql",
  "opcuaread",
  "mtconnectread",
  "mqttread",
  "sparkplugread",
]);

/**
 * The curated readings a declaration may request, the schema's `agentReading` enum, in its order: the vocabulary of
 * `facets.agentReadings`, the kinds `CURATED_OPERATION_KINDS` names.
 */
export const AGENT_READING_NAMES: readonly AgentReading[] = Object.freeze([
  "sessions",
  "slow-queries",
  "table-stats",
  "index-stats",
  "storage",
  "health",
]);

/**
 * The name quotes a `sql` redaction may name, the schema's `nameQuote` enum, in its order: the vocabulary of a `sql`
 * redaction's `nameQuote`.
 */
export const SQL_NAME_QUOTES: readonly NameQuote[] = Object.freeze(['"', "`", "[", null]);

/** Core's sentence for a connection whose file access is denied, on an engine Studio holds no refusal row for. */
export const UNGRANTED_DENIED_FILE_ACCESS_SENTENCE =
  "Connections of this engine require an administrator because Studio holds no grant that its provider confines file access for a caller whose file access is denied";

/** The sentence every open of an engine whose single-writer file request is not its grant is refused with. */
export const UNGRANTED_SINGLE_WRITER_FILE_SENTENCE =
  "Studio opens no connection of this engine because its request for how many handles one file may hold is not the one Studio granted, and a second read-write handle on one file can lose committed rows";

/** Core's sentence for a connection whose tunnel is on, on an engine Studio holds no tunnel row for. */
export const UNGRANTED_SSH_TUNNEL_SENTENCE =
  "This engine does not run through an SSH tunnel: Studio holds no grant that its provider reaches its server only through the one address a tunnel forwards. Turn the tunnel off.";

/** Refuses `value`, requested by `engine` at `claim`, as outside the claim's vocabulary. */
function refused(engine: string, claim: string, value: unknown): never {
  throw new Error(`${engine} requests ${claim} ${JSON.stringify(value)}, which is not a value of the claim`);
}

/** Refuses `value`, the row Studio's record of `claim` holds for `engine`, as outside the claim's vocabulary. */
function refusedRow(engine: string, claim: string, value: unknown): never {
  throw new Error(
    `Studio's record of ${claim} holds ${JSON.stringify(value)} for ${engine}, which is not a value of the claim`,
  );
}

/** `value` as a boolean request, or refused by name. */
function booleanRequest(engine: string, claim: string, value: unknown): boolean {
  if (typeof value !== "boolean") refused(engine, claim, value);
  return value;
}

/** The rank of a write reach from the most restrictive, `open` 0, or undefined for a value that is no write reach. */
function writeReachRank(value: unknown): number | undefined {
  switch (value) {
    case "open":
      return 0;
    case "guarded":
      return 1;
    case "none":
      return 2;
  }
  return undefined;
}

/** The write reaches by rank, `writeReachRank`'s inverse. */
const WRITE_REACH_BY_RANK: readonly WriteReach[] = ["open", "guarded", "none"];

/** `value` as an agent credential form request, or refused by name. */
function agentCredentialFormRequest(engine: string, value: unknown): AgentCredentialFormClaim {
  switch (value) {
    case "pair":
    case "token":
    case "service-account-key":
    case "dedicated-user":
    case "none":
      return value;
  }
  return refused(engine, "policy.agentCredentialForm", value);
}

/** `value` as a masking exemption request, a column pattern and a reason or null, or refused by name. */
function maskingExemptionRequest(engine: string, value: unknown): MaskingExemption {
  if (value === null) return null;
  if (
    typeof value === "object" &&
    typeof (value as { column?: unknown }).column === "string" &&
    typeof (value as { reason?: unknown }).reason === "string"
  ) {
    return value as NonNullable<MaskingExemption>;
  }
  return refused(engine, "policy.maskingExemptColumns", value);
}

/** Whether `value` is a list of host path fields, each of `HOST_PATH_FIELD_NAMES`. */
function isHostPathFieldList(value: unknown): value is readonly HostPathField[] {
  return (
    Array.isArray(value) &&
    value.every((field) => typeof field === "string" && (HOST_PATH_FIELD_NAMES as readonly string[]).includes(field))
  );
}

/** `value` as an SSH tunnel request, offered or refused with a sentence, or refused by name. */
function sshTunnelRequest(engine: string, value: unknown): ConnectionClaims["sshTunnel"] {
  if (typeof value === "object" && value !== null) {
    const { offered, refusal } = value as { offered?: unknown; refusal?: unknown };
    if (offered === true) return { offered };
    if (offered === false && typeof refusal === "string") return { offered, refusal };
  }
  return refused(engine, "connection.sshTunnel", value);
}

/** A seed agent credential as a declaration requests it: a form, and the fields that supersede it, read as text. */
interface AgentCredentialRequest {
  readonly form: SeedAgentCredential["form"];
  readonly supersededBy: readonly string[];
}

/**
 * `value` as a seed agent credential request, a fresh frozen form and list of superseding fields built from checked
 * values, or null, or refused by name. A superseding field is read as the text the declaration names, never as a field
 * of Studio's: the grant is the row's narrowed credential, which a request naming any other field never equals.
 */
function agentCredentialRequest(engine: string, value: unknown): AgentCredentialRequest | null {
  if (value === null) return null;
  if (typeof value === "object") {
    const { form, supersededBy } = value as { form?: unknown; supersededBy?: unknown };
    if ((form === "pair" || form === "dedicated-pair" || form === "secret") && Array.isArray(supersededBy)) {
      const fields = supersededBy.map((field: unknown) =>
        typeof field === "string" ? field : refused(engine, "connection.agentCredential", value),
      );
      return Object.freeze({ form, supersededBy: Object.freeze(fields) });
    }
  }
  return refused(engine, "connection.agentCredential", value);
}

/** `value` as a statement language request, a language of `STATEMENT_LANGUAGE_NAMES` or null, or refused by name. */
function statementLanguageRequest(engine: string, value: unknown): StatementLanguage {
  if (value === null) return null;
  const language = STATEMENT_LANGUAGE_NAMES.find((name) => name === value);
  return language ?? refused(engine, "agent.statementLanguage", value);
}

/** `value` as an agent readings request, a list of `AGENT_READING_NAMES`, or refused by name. */
function agentReadingsRequest(engine: string, value: unknown): readonly AgentReading[] {
  if (Array.isArray(value) && value.every((reading) => AGENT_READING_NAMES.some((name) => name === reading))) {
    return value as readonly AgentReading[];
  }
  return refused(engine, "facets.agentReadings", value);
}

/** `value` as a denied file access refusal request, a sentence or null, or refused by name. */
function refusalRequest(engine: string, value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  return refused(engine, "policy.deniedFileAccessRefusal", value);
}

/** A grammar digest as a SQL text request carries it: 64 lower-case hex characters. */
const GRAMMAR_SHA256 = /^[0-9a-f]{64}$/;

/** `value` as a redaction request, a `sql`, `command` or `none` redaction, or refused by name. */
function redactionRequest(engine: string, value: unknown): StatementRedaction {
  if (typeof value === "object" && value !== null) {
    const { kind, nameQuote, reader } = value as { kind?: unknown; nameQuote?: unknown; reader?: unknown };
    if (kind === "sql" && SQL_NAME_QUOTES.some((quote) => quote === nameQuote)) return value as StatementRedaction;
    if (kind === "command" && typeof reader === "string") return value as StatementRedaction;
    if (kind === "none") return value as StatementRedaction;
  }
  return refused(engine, "sqlText.redaction", value);
}

/** `value` as an exempt forms request, a list of forms each a list of words, or refused by name. */
function exemptFormsRequest(engine: string, value: unknown): readonly (readonly string[])[] {
  if (
    Array.isArray(value) &&
    value.every((form) => Array.isArray(form) && form.every((word) => typeof word === "string"))
  ) {
    return value as readonly (readonly string[])[];
  }
  return refused(engine, "sqlText.grammar.confirmExemptForms", value);
}

/** `value` as a grammar digest request, 64 lower-case hex characters or null, or refused by name. */
function grammarSha256Request(engine: string, value: unknown): string | null {
  if (value === null || (typeof value === "string" && GRAMMAR_SHA256.test(value))) return value;
  return refused(engine, "sqlText.grammarSha256", value);
}

/** Whether a redaction request is the row: the same kind, and the same name quote or command reader's name. */
function sameRedaction(requested: StatementRedaction, row: RegisterRedaction): boolean {
  switch (requested.kind) {
    case "sql":
      return row.kind === "sql" && row.nameQuote === requested.nameQuote;
    case "command":
      return row.kind === "command" && row.reader === requested.reader;
    case "none":
      return row.kind === "none";
  }
}

/** Whether two forms have the same words in the same order, each compared upper-cased as the confirmation gate does. */
function sameForm(listed: readonly string[], asked: readonly string[]): boolean {
  return (
    listed.length === asked.length &&
    listed.every((word, index) => word.toUpperCase() === (asked[index] as string).toUpperCase())
  );
}

/** The row `rows` holds for `engine` as an own property, or `absent` where it holds none. */
function rowOf<T, A>(rows: Rows<T>, engine: string, absent: A): T | A {
  return Object.hasOwn(rows, engine) ? (rows[engine] as T) : absent;
}

/** A restrictive-true claim's grant: true where the request or the row is, or no row exists. */
function grantedTrue(engine: string, claim: string, requested: unknown, rows: Rows<boolean>): boolean {
  return booleanRequest(engine, claim, requested) || rowOf(rows, engine, true);
}

/** A restrictive-false claim's grant: true only where the request and the row both are. */
function grantedFalse(engine: string, claim: string, requested: unknown, rows: Rows<boolean>): boolean {
  return booleanRequest(engine, claim, requested) && rowOf(rows, engine, false);
}

/** One engine's grant of every claim, the same members `ClaimGrants` holds tables of. */
type EngineGrant = { readonly [M in keyof ClaimGrants<string>]: ClaimGrants<string>[M][string] };

/** The grant of the policy claims `policy` that `engine` requests, against `records`. */
function grantPolicy(engine: string, policy: PolicyClaims, records: ClaimRecords) {
  const row = rowOf<WriteReach, WriteReach>(records.writeReach, engine, "open");
  const reach = Math.min(
    writeReachRank(policy.writeReach) ?? refused(engine, "policy.writeReach", policy.writeReach),
    writeReachRank(row) ?? refusedRow(engine, "policy.writeReach", row),
  );
  const refusal = refusalRequest(engine, policy.deniedFileAccessRefusal);
  const singleWriterRequest = booleanRequest(engine, "policy.singleWriterFile", policy.singleWriterFile);
  const singleWriterGrant = rowOf(records.singleWriterFile, engine, false);
  const form = agentCredentialFormRequest(engine, policy.agentCredentialForm);
  const formRow = rowOf<AgentCredentialForm | null, undefined>(records.agentCredentialForm, engine, undefined);
  const exemption = maskingExemptionRequest(engine, policy.maskingExemptColumns);
  const exemptionRow = rowOf<MaskingExemption, null>(records.maskingExemptColumns, engine, null);
  return {
    writeReach: WRITE_REACH_BY_RANK[reach] as WriteReach,
    readsFileAccessPosture: grantedTrue(
      engine,
      "policy.readsFileAccessPosture",
      policy.readsFileAccessPosture,
      records.readsFileAccessPosture,
    ),
    deniedFileAccessRefusal:
      refusal ?? rowOf(records.deniedFileAccessRefusal, engine, UNGRANTED_DENIED_FILE_ACCESS_SENTENCE),
    singleWriterFile: singleWriterRequest === singleWriterGrant ? singleWriterGrant : false,
    singleWriterRefusal: singleWriterRequest === singleWriterGrant ? null : UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
    readRootsRequired: grantedTrue(
      engine,
      "policy.readRootsRequired",
      policy.readRootsRequired,
      records.readRootsRequired,
    ),
    agentCredentialForm: formRow !== undefined && form === (formRow ?? "pair") ? formRow : "none",
    maskingExemptColumns:
      exemption !== null &&
      exemptionRow !== null &&
      exemption.column === exemptionRow.column &&
      exemption.reason === exemptionRow.reason
        ? Object.freeze({ column: exemptionRow.column, reason: exemptionRow.reason })
        : null,
  } as const;
}

/**
 * The host path fields granted to `engine` requesting `requested`: the union of the request and the row of `records`,
 * or of the request and every host path field among `seedOnly`'s fields where no row exists, the row's or those fields
 * first; the row itself where the request adds nothing.
 */
function grantedHostPathFields(
  engine: string,
  requested: unknown,
  records: ClaimRecords,
  seedOnly: SeedOnlyRow,
): readonly HostPathField[] {
  if (!isHostPathFieldList(requested)) refused(engine, "connection.hostPathFields", requested);
  const row = rowOf<readonly HostPathField[], undefined>(records.hostPathFields, engine, undefined);
  if (row !== undefined && !isHostPathFieldList(row)) refusedRow(engine, "connection.hostPathFields", row);
  const base = row ?? Object.freeze(HOST_PATH_FIELD_NAMES.filter((field) => (seedOnly?.fields ?? []).includes(field)));
  const added = requested.filter((field, index) => !base.includes(field) && requested.indexOf(field) === index);
  return added.length === 0 ? base : Object.freeze([...base, ...added]);
}

/** Whether a request and a row are the same form with the same superseding fields, by name, in the same order. */
function sameAgentCredential(requested: AgentCredentialRequest, row: SeedAgentCredential): boolean {
  return (
    requested.form === row.form &&
    requested.supersededBy.length === row.supersededBy.length &&
    requested.supersededBy.every((field, index) => field === row.supersededBy[index])
  );
}

/** The grant of the connection claims `connection` that `engine` requests, against `records`. */
function grantConnection(engine: string, connection: ConnectionClaims, records: ClaimRecords, seedOnly: SeedOnlyRow) {
  const tunnel = sshTunnelRequest(engine, connection.sshTunnel);
  const credential = agentCredentialRequest(engine, connection.agentCredential);
  const credentialRow = rowOf<SeedAgentCredential | null, null>(records.agentCredential, engine, null);
  const serverLevel = "connection.serverLevelWithoutDatabase";
  return {
    opensLocalFile: grantedTrue(engine, "connection.opensLocalFile", connection.opensLocalFile, records.opensLocalFile),
    hostPathFields: grantedHostPathFields(engine, connection.hostPathFields, records, seedOnly),
    serverLevelAtAdmission: grantedTrue(
      engine,
      serverLevel,
      connection.serverLevelWithoutDatabase,
      records.serverLevelWithoutDatabase,
    ),
    serverLevelAtCatalogChoice: grantedFalse(
      engine,
      serverLevel,
      connection.serverLevelWithoutDatabase,
      records.serverLevelWithoutDatabase,
    ),
    sshTunnel: tunnel.offered ? rowOf(records.sshTunnel, engine, UNGRANTED_SSH_TUNNEL_SENTENCE) : tunnel.refusal,
    agentCredential:
      credential !== null && credentialRow !== null && sameAgentCredential(credential, credentialRow)
        ? credentialRow
        : null,
  } as const;
}

/** The grant of the agent mode claims `facets` and `agent` that `engine` requests, against `records`. */
function grantAgentMode(engine: string, facets: FacetClaims, agent: AgentClaims, records: ClaimRecords) {
  const language = statementLanguageRequest(engine, agent.statementLanguage);
  const readings = agentReadingsRequest(engine, facets.agentReadings);
  const row = rowOf(records.agentReadings, engine, undefined);
  return {
    statementLanguage:
      language !== null && language === rowOf(records.statementLanguage, engine, null) ? language : null,
    agentReadings: Object.freeze((row ?? []).filter((reading) => readings.includes(reading))),
  } as const;
}

/** The grant of every claim `requested` by `engine`, against `records`, its seed-only fields `seedOnly`. */
function grantEngine(
  engine: string,
  requested: ClaimRequestEntry,
  records: ClaimRecords,
  seedOnly: Rows<SeedOnlyRow>,
): EngineGrant {
  if (!Object.hasOwn(seedOnly, engine)) {
    throw new Error(`${engine} has no seed-only row, so Studio cannot grant its host path fields`);
  }
  const policy = grantPolicy(engine, requested.policy, records);
  const connection = grantConnection(engine, requested.connection, records, seedOnly[engine] ?? null);
  const mcp: McpClaims = requested.mcp;
  const agentCredentialRequired = grantedTrue(
    engine,
    "mcp.agentCredentialRequired",
    mcp.agentCredentialRequired,
    records.agentCredentialRequired,
  );
  const exposed = grantedFalse(engine, "mcp.exposable", mcp.exposable, records.exposable);
  const takesNoAgentCredential = connection.agentCredential === null || policy.agentCredentialForm === "none";
  return {
    writeReach: policy.writeReach,
    readsFileAccessPosture: policy.readsFileAccessPosture,
    deniedFileAccessRefusal: policy.deniedFileAccessRefusal,
    singleWriterFile: policy.singleWriterFile,
    readRootsRequired: policy.readRootsRequired,
    agentCredentialForm: policy.agentCredentialForm,
    maskingExemptColumns: policy.maskingExemptColumns,
    exposable: exposed && !(agentCredentialRequired && takesNoAgentCredential),
    statementRead: grantedFalse(engine, "mcp.statementRead", mcp.statementRead, records.statementRead),
    metadataReadChangesState: grantedTrue(
      engine,
      "mcp.metadataReadChangesState",
      mcp.metadataReadChangesState,
      records.metadataReadChangesState,
    ),
    agentCredentialRequired,
    readOnlyEnforced: policy.writeReach !== "open",
    ungrantedRefusals: policy.singleWriterRefusal,
    ...connection,
    ...grantAgentMode(engine, requested.facets, requested.agent, records),
  };
}

/** The members of `ClaimGrants` a browser module reads as a table, in the order their tables are built. */
const GRANT_MEMBERS = ["writeReach", "sshTunnel", "statementLanguage", "agentReadings"] as const;

/** The tables of the members of `GRANT_MEMBERS`. */
type BrowserGrantTables<K extends string> = Pick<ClaimGrants<K>, (typeof GRANT_MEMBERS)[number]>;

/**
 * The SQL text claims of one engine as `grantEngineClaims` reads them, each checked against its claim's vocabulary:
 * `readsSqlText`, `confirmExemptForms` (`sqlText.grammar.confirmExemptForms`) and `redaction` as the declaration
 * states them, and `grammarSha256`, the digest of the grammar the declaration states (src/lib/db/grammar-digest.ts),
 * or null for none. The server catalog's composer hands a package engine's from its admitted declaration, the digest
 * computed on the server; a legacy engine's is its bundled readsSqlText and exempt forms with its legacy row's
 * redaction and digest (`legacySqlTextRequest`).
 */
export interface SqlTextRequest {
  readonly readsSqlText: boolean;
  readonly confirmExemptForms: readonly (readonly string[])[];
  readonly redaction: StatementRedaction;
  readonly grammarSha256: string | null;
}

/** The redaction a SQL text claim is read at where no grant covers it: nothing of a statement's text is kept. */
const NO_REDACTION: RegisterRedaction = Object.freeze({ kind: "none" });

/**
 * The grant of the SQL text claims `sqlText` that `engine` requests, against `row`, the engine's register row or null:
 * each claim at its restrictive value unless the row reviewed the grammar the request carries the digest of.
 */
function grantSqlText(engine: string, sqlText: SqlTextRequest, row: RegisterRow | null) {
  const redaction = redactionRequest(engine, sqlText.redaction);
  const readsSqlText = booleanRequest(engine, "sqlText.readsSqlText", sqlText.readsSqlText);
  const forms = exemptFormsRequest(engine, sqlText.confirmExemptForms);
  const digest = grammarSha256Request(engine, sqlText.grammarSha256);
  const reviewed = row !== null && row.grants.grammarSha256 !== null && digest === row.grants.grammarSha256;
  if (!reviewed) {
    return {
      redaction: NO_REDACTION,
      readsSqlText: true,
      confirmExemptForms: Object.freeze([]),
      decidesAlone: false,
      reviewedGrammar: false,
    } as const;
  }
  const granted = row.grants;
  return {
    redaction: sameRedaction(redaction, granted.redaction) ? Object.freeze({ ...granted.redaction }) : NO_REDACTION,
    readsSqlText: readsSqlText || granted.readsSqlText,
    confirmExemptForms: Object.freeze(
      forms
        .filter((form) => granted.confirmExemptForms.some((listed) => sameForm(listed, form)))
        .map((form) => Object.freeze([...form])),
    ),
    decidesAlone: granted.decidesAlone,
    reviewedGrammar: true,
  } as const;
}

/**
 * Studio's grant of each claim of one engine, one value per member of `ClaimGrants`, and of the three host facts no
 * declaration requests, read from the engine's register row alone:
 * - `ownWords`: how the engine's own words reach the client, through core's scrub (`"scrubbed"`), or only as Studio's
 *   sentence naming their code (`"code-only"`, src/lib/api/package-errors.ts), which is what an engine with no row reads;
 * - `servesOneSession`: the reason the engine's connections serve their object tree from one session, or null, which is
 *   what an engine with no row reads;
 * - `agentExecution`: whether agent mode executes statements on the engine, false where no row exists;
 * and the grant of each SQL text claim, for the grammar the row reviewed (`grantSqlText`):
 * - `redaction`: how the query event log keeps a statement of the engine, `none` where no grant covers it;
 * - `readsSqlText`: whether the confirmation gate reads the engine's text as SQL, true where no grant covers it;
 * - `confirmExemptForms`: the forms the confirmation gate exempts, none where no grant covers them;
 * - `decidesAlone`: whether the engine's statement vocabulary may decide the confirmation gate's answer alone, false
 *   where no grant covers it; no declaration requests it, a vocabulary row's own flag is its request;
 * - `reviewedGrammar`: whether the row reviewed the grammar the request carries the digest of.
 */
export type EngineGrants = EngineGrant & {
  readonly ownWords: RegisterGrants["ownWords"];
  readonly servesOneSession: string | null;
  readonly agentExecution: boolean;
  readonly redaction: RegisterRedaction;
  readonly readsSqlText: boolean;
  readonly confirmExemptForms: readonly (readonly string[])[];
  readonly decidesAlone: boolean;
  readonly reviewedGrammar: boolean;
};

/** One engine's records of every claim, each holding no row: every claim is read at its restrictive value. */
const NO_ROW: ClaimRecords = Object.freeze({
  writeReach: Object.freeze({}),
  readsFileAccessPosture: Object.freeze({}),
  deniedFileAccessRefusal: Object.freeze({}),
  singleWriterFile: Object.freeze({}),
  readRootsRequired: Object.freeze({}),
  agentCredentialForm: Object.freeze({}),
  maskingExemptColumns: Object.freeze({}),
  exposable: Object.freeze({}),
  statementRead: Object.freeze({}),
  metadataReadChangesState: Object.freeze({}),
  agentCredentialRequired: Object.freeze({}),
  opensLocalFile: Object.freeze({}),
  hostPathFields: Object.freeze({}),
  serverLevelWithoutDatabase: Object.freeze({}),
  sshTunnel: Object.freeze({}),
  agentCredential: Object.freeze({}),
  statementLanguage: Object.freeze({}),
  agentReadings: Object.freeze({}),
});

/**
 * Engine `engine`'s records of every claim from `grants`, the grants of its register row: each member a record of that
 * engine's row alone, the agent credential narrowed by `legacyAgentCredentials` to the text fields a connection form
 * draws.
 */
function rowRecords(engine: string, grants: RegisterGrants): ClaimRecords {
  const one = <T>(value: T): Rows<T> => Object.freeze({ [engine]: value });
  return Object.freeze({
    writeReach: one(grants.writeReach),
    readsFileAccessPosture: one(grants.readsFileAccessPosture),
    deniedFileAccessRefusal: one(grants.deniedFileAccessRefusal),
    singleWriterFile: one(grants.singleWriterFile),
    readRootsRequired: one(grants.readRootsRequired),
    agentCredentialForm: one(grants.agentCredentialForm),
    maskingExemptColumns: one(grants.maskingExemptColumns),
    exposable: one(grants.exposable),
    statementRead: one(grants.statementRead),
    metadataReadChangesState: one(grants.metadataReadChangesState),
    agentCredentialRequired: one(grants.agentCredentialRequired),
    opensLocalFile: one(grants.opensLocalFile),
    hostPathFields: one(grants.hostPathFields),
    serverLevelWithoutDatabase: one(grants.serverLevelWithoutDatabase),
    sshTunnel: one(grants.sshTunnel),
    agentCredential: legacyAgentCredentials({ [engine]: grants }, BODY_CONNECTION_FIELDS),
    statementLanguage: one(grants.statementLanguage),
    agentReadings: one(grants.agentReadings),
  });
}

/**
 * Studio's grant of every policy, MCP, connection, agent mode and SQL text claim `requested` and `sqlText` by engine
 * `engine`, against `row`, the engine's row of the grant register, or null where the register holds none, so every
 * claim is read at its restrictive value; with `seedOnly` the seed-only fields of every engine, read for the host path
 * fields where no row exists. The one call that grants an engine's claims, for a legacy engine and a package's alike: a
 * legacy engine is handed its legacy row, a package's engine its row keyed by the package's name, version and digest.
 * The answer is frozen, each value the register's own deep-frozen value or a fresh frozen one.
 *
 * @throws {Error} Naming both engines, for a row of another engine: a host defect, the row is never read. Naming the
 * engine, the claim and the value, for a request value outside its claim's vocabulary; naming Studio's record, the
 * claim, the value and the engine, for a row value outside it; naming the engine and the field, for a row's superseding
 * field that is not a text field a connection form draws; naming the engine, for an engine `seedOnly` holds no row for.
 */
export function grantEngineClaims(
  engine: string,
  requested: ClaimRequestEntry,
  sqlText: SqlTextRequest,
  row: RegisterRow | null,
  seedOnly: Rows<SeedOnlyRow>,
): EngineGrants {
  if (row !== null && row.engine !== engine) {
    throw new Error(`grantEngineClaims was handed the register row of ${row.engine} for ${engine}`);
  }
  return Object.freeze({
    ...grantEngine(engine, requested, row === null ? NO_ROW : rowRecords(engine, row.grants), seedOnly),
    ownWords: row === null ? "code-only" : row.grants.ownWords,
    servesOneSession: row === null ? null : row.grants.servesOneSession,
    agentExecution: row === null ? false : row.grants.agentExecution,
    ...grantSqlText(engine, sqlText, row),
  });
}

/**
 * Legacy engine `id`'s SQL text request: the readsSqlText and exempt forms of its bundled SQL text, and its legacy
 * row's redaction and grammar digest. No projection carries a declaration's redaction or grammar digest, so the request
 * holds its row's own; tests/unit/db/engine-declarations.test.ts holds every legacy declaration's redaction, and the
 * digest of its grammar, equal to its row's, so the request is the declaration's by construction, and a changed
 * legacy grammar fails CI until its row is reviewed again.
 */
function legacySqlTextRequest(id: DatabaseType): SqlTextRequest {
  const { grants } = LEGACY_GRANT_ROWS[id];
  const declared = BUNDLED_SQL_TEXT[id];
  return {
    readsSqlText: declared.readsSqlText,
    confirmExemptForms: declared.grammar.confirmExemptForms,
    redaction: grants.redaction,
    grammarSha256: grants.grammarSha256,
  };
}

/** Every legacy engine's grants, keyed by its id in `SHIPPED_DATABASE_TYPES`' order, granted once at load. */
const LEGACY_ENGINE_GRANTS: ReadonlyMap<string, EngineGrants> = new Map(
  SHIPPED_DATABASE_TYPES.map((id) => [
    id,
    grantEngineClaims(
      id,
      BUNDLED_CLAIM_REQUESTS[id],
      legacySqlTextRequest(id),
      LEGACY_GRANT_ROWS[id],
      SEED_ONLY_FIELDS,
    ),
  ]),
);

/**
 * Studio's grant of each claim of legacy engine `id`: `grantEngineClaims` with its bundled request, its SQL text request
 * (`legacySqlTextRequest`) and its legacy row, which the legacy adapter's record of the engine holds
 * (src/lib/provider-host/legacy-adapter/records.ts).
 *
 * @throws {Error} Naming the id, for an id the legacy adapter does not serve: a host defect.
 */
export function legacyEngineGrants(id: string): EngineGrants {
  const grants = LEGACY_ENGINE_GRANTS.get(id);
  if (grants === undefined) {
    throw new Error(
      `the grant reader holds no legacy grants for ${id}: the legacy adapter serves no engine of that id`,
    );
  }
  return grants;
}

/**
 * Member by member over `GRANT_MEMBERS`, the grants of each engine of `engines`, `grantsOf` answering each, transposed
 * into one frozen table per member keyed by `engines` in their order: the tables below, cut from the legacy engines'
 * grants for the browser modules that read a table until M7.
 */
function grantTables<K extends string>(
  engines: readonly K[],
  grantsOf: (engine: K) => EngineGrants,
): BrowserGrantTables<K> {
  const grants = engines.map((engine) => [engine, grantsOf(engine)] as const);
  return Object.freeze(
    Object.fromEntries(
      GRANT_MEMBERS.map((member) => [
        member,
        Object.freeze(Object.fromEntries(grants.map(([engine, grant]) => [engine, grant[member]]))),
      ]),
    ),
  ) as unknown as BrowserGrantTables<K>;
}

/** Studio's grant of every legacy engine's claims a browser module reads, as one table per member. */
const BUNDLED_GRANTS = grantTables(SHIPPED_DATABASE_TYPES, legacyEngineGrants);

/**
 * Studio's grant of `policy.writeReach`, which the connection form reads before a provider exists; the seed schema
 * reads the engine record's `grants.writeReach`. It is no MCP criterion and no MCP code reads it
 * (tests/unit/mcp/no-write-reach.test.ts): whether a machine client may read an engine is the grant of `mcp.exposable`,
 * whatever the engine's write reach.
 */
export const GRANTED_WRITE_REACH: Readonly<Record<DatabaseType, WriteReach>> = BUNDLED_GRANTS.writeReach;

/**
 * Studio's grant of `connection.sshTunnel`, in the record's vocabulary: the sentence a tunnel that is on is refused
 * with, or null where the engine takes one. The connection dialog reads it; core's tunnel decision and the provider's
 * fields read an engine's record's `grants.sshTunnel`. Core decides a tunnel in `decideTunnel` (./tunnel-decision) on
 * every entry point before any cache lookup, bastion dial or provider build, so no provider refuses a tunnel itself,
 * and the dialog offers the SSH panel, and writes `sshTunnel`, exactly where the grant is null, so the dialog and core
 * cannot disagree. No review row's sentence quotes a value of the connection.
 */
export const GRANTED_SSH_TUNNEL_REFUSAL: Readonly<Record<DatabaseType, string | null>> = BUNDLED_GRANTS.sshTunnel;

/**
 * Studio's grant of `agent.statementLanguage`: the language agent mode sends the engine, or null where it sends none.
 * The agent posture, workflow availability and the agent rail read it; the classify route, the engine pack resolver and
 * the MCP served set and arms read the engine record's `grants.statementLanguage`.
 */
export const GRANTED_AGENT_STATEMENT_LANGUAGE: Readonly<Record<DatabaseType, StatementLanguage>> =
  BUNDLED_GRANTS.statementLanguage;

/**
 * Studio's grant of `facets.agentReadings`: the curated readings agent mode is offered on the engine, in its legacy
 * row's order. Whether the operations workflow opens in agent mode (the agent manifest) reads it; the readings
 * `inspect_operations` offers and accepts, and the run ledger's reading check, read the engine record's
 * `grants.agentReadings`.
 */
export const GRANTED_AGENT_READINGS: Readonly<Record<DatabaseType, readonly AgentReading[]>> =
  BUNDLED_GRANTS.agentReadings;

/**
 * Studio's grant of agent execution: the engines on which **agent mode** executes statements itself, Studio's review of
 * the engines agent and MCP statements run on, in catalog order. It is each legacy row's `agentExecution` member of
 * the grant register, a host fact no declaration requests, so no claim is granted from it and an engine with no
 * legacy row is not on it.
 *
 * Every agent and MCP statement gate reads the same grant at run time, and an engine it does not grant is refused by
 * name, whatever its provider implements: the start of a statement-sending agent run (`workflowAvailability`,
 * `src/lib/agent/agent-manifest.ts`) reads this list; the factory's `agent-read-only` and `agent-handover` acquisition
 * and the core read path every agent, hand-over and MCP read-only statement passes (`runReadOnlyReading`; plan mode's
 * statistics read under `agent-operations` does not), both through `assertStatementsReviewed`
 * (`src/lib/db/statement-review.ts`, `PROFILE_ENGINE_NOT_REVIEWED`), and MCP's served set
 * (`src/lib/mcp/tools/served-engines.ts`) read the engine record's `grants.agentExecution`. A provider's read-only
 * statement path is a second precondition, required and never enough: an engine on the list whose provider has no
 * `queryReadOnly` is still refused `PROFILE_UNSUPPORTED_BY_PROVIDER`, never served `query()`.
 *
 * The engines do not draw the boundary the same way, and the list deliberately says nothing about that: each listed
 * engine's boundary is its legacy row's `reasons.agentExecution` note, where one is written, and each provider's own
 * `queryReadOnly` argues its own case. `tests/unit/lib/agent/engine-support.test.ts` holds the first-party providers to
 * these rows in both directions: it walks every id in the `DatabaseType` union and reads `queryReadOnly` off the real
 * provider class the factory would construct, so a reviewed engine always has its protected read path, and a provider
 * that gains one fails there until its review row is written.
 *
 * Two things it deliberately does NOT say, because user-facing copy that compresses them overclaims (docs/AGENT.md, the
 * "Agent mode requires" paragraph that opens it):
 * - **Plan mode opens on every engine and runs no statement of the model's anywhere.** Since #414 a plan run is
 *   grounded, and this list reaches only that grounding: see below.
 * - **The `operations` workflow opens without this list, in both modes**, because it composes no SQL: its
 *   `agent-operations` acquisition sets `requiresReadOnlyStatements: false`. In agent mode it opens on every engine
 *   Studio grants a curated reading, `GRANTED_AGENT_READINGS`.
 *
 * Both are grounded before their first turn, and on an engine whose catalog read is a composed statement (its
 * overlay's `catalogCapture`) that read is sent under `agent-read-only`, so it passes this list like any other
 * statement. On such an engine off the list the acquisition is refused `PROFILE_ENGINE_NOT_REVIEWED` and plan mode and
 * the operations workflow run ungrounded; it is not routed to `agent-operations` instead, because a composed statement
 * is a statement.
 *
 * The browser reads it too, the unauthenticated login hero, the agent manifest and the agent posture, so no provider
 * class or database driver may enter this module's imports: one would drag a driver toward the login bundle. Frozen,
 * so no code widens it at run time.
 */
export const GRANTED_AGENT_EXECUTION_ENGINES: readonly DatabaseType[] = Object.freeze(
  SHIPPED_DATABASE_TYPES.filter((engine) => legacyEngineGrants(engine).agentExecution),
);
