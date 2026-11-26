/**
 * Studio's grant of each policy, MCP, connection and agent mode claim an engine declaration requests
 * (docs/providers/CONTRACT.md, clauses M-54, M-82 and M-83): the one module that reads a request,
 * `BUNDLED_CLAIM_REQUESTS`, and Studio's review of each claim for each engine, and the module every gate reads in their
 * place.
 *
 * A claim is a request, never a fact Studio believes as declared (clause M-52). So each claim is granted as the more
 * restrictive of the engine's request and the row of Studio's record, and at the claim's restrictive value (clause
 * M-53) where the record holds no row, one rule per claim shape:
 * - `writeReach`, ordered `open`, `guarded`, `none` from the most restrictive: the more restrictive of the two, `open`
 *   where no row exists. `READ_ONLY_ENFORCED` is true exactly where the granted write reach is not `open`.
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
 *   any other request leaves the engine refused at every open with `UNGRANTED_SINGLE_WRITER_FILE_SENTENCE`, which
 *   `UNGRANTED_CLAIM_REFUSALS` holds and the open check's `assertClaimsGranted` raises before anything is touched.
 * - `agentCredentialForm`, unordered: the row where the request equals it, the record's null row read as `pair`, and
 *   `none` otherwise or where no row exists. The granted table keeps the record's vocabulary, null for the pair.
 * - `maskingExemptColumns`, unordered: the row where the request equals it, column pattern and reason, and null
 *   otherwise or where no row exists.
 * - `connection.opensLocalFile`, restrictive when true: true where the request or the row is, or no row exists.
 * - `connection.hostPathFields`, a set a gate admits: the union of the request and the row, the row's fields first and
 *   the request's others after them in its order, the row itself where the request adds nothing; where no row exists,
 *   the union of the request and every host path field among the engine's seed-only fields, the claim's restrictive
 *   value, which `grantClaims` reads from the seed-only rows it is handed.
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
 *   always a fresh frozen list, and the empty list where no row exists. The record is the `agentReadings` member of
 *   each `ENGINE_FACETS` row, handed over whole.
 * A record's row is looked up as an own property, so a key on the prototype chain is no row. A request value outside
 * its claim's vocabulary is refused by name, naming the claim and the engine, never read at a default; a write reach
 * or host path fields row of Studio's record outside it is refused naming the record, the claim and the engine; an
 * agent credential row naming a superseding field that is not one of the engine's connection fields is refused by
 * `legacyAgentCredentials` when this module loads, naming the engine and the field; and every other row is Studio's own
 * typed table, read as it stands.
 *
 * Studio's review of each policy, MCP and connection claim for an engine the legacy adapter serves is the engine's
 * legacy row of the grant register, `@libredb/grant-register` (clause M-54), keyed by `LEGACY_KEY` and the engine id:
 * the register is read once, when this module loads, with `SHIPPED_DATABASE_TYPES`, the legacy adapter's served set,
 * and `legacyGrantRows` refuses by name a served engine the register holds no legacy row for, so no served engine is
 * read at a restrictive value by omission. A row's review notes say why it holds its value. The rows are hand-reviewed
 * data, never a projection of the declarations (clauses M-52, M-53 and M-83). A register its schema or its code rules
 * refuse fails this module's load, in the browser as on the server.
 * Studio's review of every other claim stays a hand-written record, the statement language record of
 * src/lib/db/compatibility.ts and the facet rows of src/lib/db/engine-facets, which import nothing of this module. tests/unit/db/claim-record-readers.test.ts holds that no other module of Studio's
 * source reads those records, the facet rows' `agentReadings` by member, or loads the register, and
 * tests/unit/db/engine-declaration-readers.test.ts that no other module reads a request. For every engine Studio ships
 * each request is its review row, so each granted table equals that row there.
 *
 * The tables are computed once, when this module loads, over the bundled declarations; the server catalog's composer
 * grants an admitted provider package's claims the same way, through `grantPackageClaims`. The module holds literals,
 * the facet rows, generated data and the register's rows only, and the register's reader compiles no code, so the
 * browser's readers, the read-only marker, the connection form and the agent rail, load it as they load the records.
 */
import type {
  AgentCredentialFormClaim,
  AgentReading,
  McpClaims,
  PolicyClaims,
  StatementLanguage,
} from "@libredb/provider-sdk/manifest";
import { type GrantRegister, LEGACY_KEY, type RegisterGrants, readGrantRegister } from "@libredb/grant-register";
import type { DatabaseType, HostPathField } from "@/lib/types";
import { AGENT_STATEMENT_LANGUAGE, SHIPPED_DATABASE_TYPES } from "./compatibility";
import {
  CONNECTION_FIELDS,
  type ConnectionField,
  SEED_ONLY_FIELDS,
  type SeedAgentCredential,
} from "./connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "./engine-catalog/claims.generated";
import type { AgentClaims, ClaimRequestEntry, ConnectionClaims, FacetClaims } from "./engine-catalog/projection";
import { ENGINE_FACETS } from "./engine-facets";
import type { AgentCredentialForm, ProviderCapabilities } from "./types";
import type { WriteReach } from "./write-reach";

/** A masking exemption as Studio's record holds it: a column pattern and a reason, or null. */
type MaskingExemption = NonNullable<ProviderCapabilities["maskingExemptColumns"]> | null;

/** One record of Studio's, keyed by engine id; an id it holds no row for is read at the claim's restrictive value. */
type Rows<T> = Readonly<Record<string, T>>;

/** Studio's review record of each policy, MCP, connection and agent mode claim, keyed by the member requesting it. */
export interface ClaimRecords {
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
  /** The engine's facet row, whose `agentReadings` member is the record. */
  readonly agentReadings: Rows<{ readonly agentReadings: readonly AgentReading[] }>;
}

/** An engine's seed-only fields as `grantClaims` reads them, or null where it has none. */
type SeedOnlyRow = { readonly fields: readonly string[] } | null;

/** Studio's grant of each claim for every engine of a set of requests, each table keyed as the requests are. */
export interface ClaimGrants<K extends string> {
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
 * The grants of each engine of `engines` as `register` holds them in its legacy row, keyed by engine in `engines`'
 * order: the register's own rows, deep-frozen by its reader, in a frozen record.
 *
 * @throws {Error} Naming the engine, for an engine of `engines` the register holds no legacy row for: such an engine is
 * never read at a restrictive value, since the legacy adapter serves it and its review is missing.
 */
export function legacyGrantRows(
  register: GrantRegister,
  engines: readonly string[],
): Readonly<Record<string, RegisterGrants>> {
  return Object.freeze(
    Object.fromEntries(
      engines.map((engine) => {
        const row = register.rowFor({ legacy: LEGACY_KEY, engine });
        if (row === null) {
          throw new Error(`the grant register holds no legacy row for ${engine}, an engine the legacy adapter serves`);
        }
        return [engine, row.grants];
      }),
    ),
  );
}

/**
 * The grant register's legacy rows of every engine Studio ships, read once when this module loads.
 * `SHIPPED_DATABASE_TYPES` is the legacy adapter's served set: its `LEGACY_ENGINE_IDS` is defined as it.
 */
const LEGACY_GRANT_ROWS = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), SHIPPED_DATABASE_TYPES);

/** Member `member` of every legacy row, keyed by engine: the review rows `grantClaims` reads for that claim. */
function legacyMember<M extends keyof RegisterGrants>(member: M): Rows<RegisterGrants[M]> {
  return Object.freeze(
    Object.fromEntries(Object.entries(LEGACY_GRANT_ROWS).map(([engine, grants]) => [engine, grants[member]])),
  );
}

/**
 * The agent credential of each engine of `rows`, in `rows`' order, its superseding fields narrowed to the engine's own
 * connection fields of `fields`: a null grant stays null, and every other is a fresh frozen form and list. The register
 * holds a superseding field as plain text, so each is found by name in the engine's row of `fields` and taken from
 * there, never cast; an engine `fields` holds no row for has no field to find.
 *
 * @throws {Error} Naming the engine and the field, for a superseding field that is not one of the engine's connection
 * fields: a misspelt field would otherwise never equal a request, closing the engine to an agent credential silently.
 */
export function legacyAgentCredentials(
  rows: Readonly<Record<string, RegisterGrants>>,
  fields: Rows<readonly ConnectionField[]>,
): Rows<SeedAgentCredential | null> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(rows).map(([engine, grants]) => {
        const credential = grants.agentCredential;
        if (credential === null) return [engine, null];
        const own = rowOf<readonly ConnectionField[], readonly ConnectionField[]>(fields, engine, []);
        const supersededBy = credential.supersededBy.map((name) => {
          const field = own.find((candidate) => candidate === name);
          if (field === undefined) {
            throw new Error(
              `the grant register's legacy row for ${engine} names ${JSON.stringify(name)} among the fields superseding its agent credential, which is not a connection field of the engine`,
            );
          }
          return field;
        });
        return [engine, Object.freeze({ form: credential.form, supersededBy: Object.freeze(supersededBy) })];
      }),
    ),
  );
}

/** Studio's records, as `grantClaims` reads them for the bundled declarations. */
export const STUDIO_CLAIM_RECORDS: ClaimRecords = Object.freeze({
  writeReach: legacyMember("writeReach"),
  readsFileAccessPosture: legacyMember("readsFileAccessPosture"),
  deniedFileAccessRefusal: legacyMember("deniedFileAccessRefusal"),
  singleWriterFile: legacyMember("singleWriterFile"),
  readRootsRequired: legacyMember("readRootsRequired"),
  agentCredentialForm: legacyMember("agentCredentialForm"),
  maskingExemptColumns: legacyMember("maskingExemptColumns"),
  exposable: legacyMember("exposable"),
  statementRead: legacyMember("statementRead"),
  metadataReadChangesState: legacyMember("metadataReadChangesState"),
  agentCredentialRequired: legacyMember("agentCredentialRequired"),
  opensLocalFile: legacyMember("opensLocalFile"),
  hostPathFields: legacyMember("hostPathFields"),
  serverLevelWithoutDatabase: legacyMember("serverLevelWithoutDatabase"),
  sshTunnel: legacyMember("sshTunnel"),
  agentCredential: legacyAgentCredentials(LEGACY_GRANT_ROWS, CONNECTION_FIELDS),
  statementLanguage: AGENT_STATEMENT_LANGUAGE,
  agentReadings: ENGINE_FACETS,
});

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

/** `value` as a seed agent credential request, a form and the fields that supersede it, or null, or refused by name. */
function agentCredentialRequest(engine: string, value: unknown): ConnectionClaims["agentCredential"] {
  if (value === null) return null;
  if (typeof value === "object") {
    const { form, supersededBy } = value as { form?: unknown; supersededBy?: unknown };
    if (
      (form === "pair" || form === "dedicated-pair" || form === "secret") &&
      Array.isArray(supersededBy) &&
      supersededBy.every((field) => typeof field === "string")
    ) {
      return value as NonNullable<ConnectionClaims["agentCredential"]>;
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

/** Whether two seed agent credentials are the same form with the same superseding fields in the same order. */
function sameAgentCredential(
  requested: NonNullable<ConnectionClaims["agentCredential"]>,
  row: SeedAgentCredential,
): boolean {
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
    agentReadings: Object.freeze((row?.agentReadings ?? []).filter((reading) => readings.includes(reading))),
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

/** The members of `ClaimGrants`, in the order its tables are built. */
const GRANT_MEMBERS: readonly (keyof ClaimGrants<string>)[] = [
  "writeReach",
  "readsFileAccessPosture",
  "deniedFileAccessRefusal",
  "singleWriterFile",
  "readRootsRequired",
  "agentCredentialForm",
  "maskingExemptColumns",
  "exposable",
  "statementRead",
  "metadataReadChangesState",
  "agentCredentialRequired",
  "readOnlyEnforced",
  "ungrantedRefusals",
  "opensLocalFile",
  "hostPathFields",
  "serverLevelAtAdmission",
  "serverLevelAtCatalogChoice",
  "sshTunnel",
  "agentCredential",
  "statementLanguage",
  "agentReadings",
];

/**
 * Studio's grant of every policy, MCP, connection and agent mode claim `requests` holds, against `records`, with
 * `seedOnly` the seed-only fields of the same engines, read for the host path fields where no record row exists: one
 * frozen table per claim, and two for the server level, one per gate, keyed by the requests' engines in their order,
 * each row frozen.
 *
 * @throws {Error} Naming the engine, the claim and the value, for a request value outside its claim's vocabulary;
 * naming Studio's record, the claim, the value and the engine, for a record row outside it; naming the engine, for an
 * engine `seedOnly` holds no row for.
 */
export function grantClaims<K extends string>(
  requests: Readonly<Record<K, ClaimRequestEntry>>,
  records: ClaimRecords,
  seedOnly: Rows<SeedOnlyRow>,
): ClaimGrants<K> {
  const engines = Object.keys(requests) as K[];
  const grants = engines.map((engine) => [engine, grantEngine(engine, requests[engine], records, seedOnly)] as const);
  return Object.freeze(
    Object.fromEntries(
      GRANT_MEMBERS.map((member) => [
        member,
        Object.freeze(Object.fromEntries(grants.map(([engine, grant]) => [engine, grant[member]]))),
      ]),
    ),
  ) as unknown as ClaimGrants<K>;
}

/**
 * Studio's grant of the claims of the engines admitted provider packages serve (docs/providers/CONTRACT.md, clause
 * C-106), against Studio's own records, with `seedOnly` their seed-only fields: `grantClaims` over `requests` and
 * `STUDIO_CLAIM_RECORDS`, the records the bundled grants read. The records hold no row for an engine Studio does not
 * ship, so each claim is granted at its restrictive value, whatever the package requests. The server catalog's
 * composer (src/lib/db/server-catalog-compose.ts) calls it once at boot.
 */
export function grantPackageClaims<K extends string>(
  requests: Readonly<Record<K, ClaimRequestEntry>>,
  seedOnly: Rows<SeedOnlyRow>,
): ClaimGrants<K> {
  return grantClaims(requests, STUDIO_CLAIM_RECORDS, seedOnly);
}

/** Studio's grant of each claim of one engine: one value per member of `ClaimGrants`, the engine's row of each table. */
export type EngineGrants = { readonly [Member in keyof ClaimGrants<string>]: ClaimGrants<string>[Member][string] };

/**
 * Engine `id`'s row of each table of `grants`, transposed into one frozen record, member by member in the order the
 * tables are built: the shape the server's engine catalog keeps for each engine (src/lib/db/server-catalog.ts).
 */
export function engineGrantsOf<K extends string>(grants: ClaimGrants<K>, id: K): EngineGrants {
  return Object.freeze(
    Object.fromEntries(GRANT_MEMBERS.map((member) => [member, grants[member][id]])),
  ) as unknown as EngineGrants;
}

/** Studio's grant of every bundled declaration's claims. */
const BUNDLED_GRANTS = grantClaims(BUNDLED_CLAIM_REQUESTS, STUDIO_CLAIM_RECORDS, SEED_ONLY_FIELDS);

/**
 * Studio's grant of each claim of bundled engine `id`, its row of every exported table below, which the legacy
 * adapter's record of the engine holds (src/lib/provider-host/legacy-adapter/records.ts).
 */
export function bundledEngineGrants(id: DatabaseType): EngineGrants {
  return engineGrantsOf(BUNDLED_GRANTS, id);
}

/**
 * Studio's grant of `policy.writeReach`, which the seed schema and the connection form read, each before a provider
 * exists. It is no MCP criterion and no MCP code reads it (tests/unit/mcp/no-write-reach.test.ts): whether a machine
 * client may read an engine is the grant of `mcp.exposable`, whatever the engine's write reach.
 */
export const GRANTED_WRITE_REACH: Readonly<Record<DatabaseType, WriteReach>> = BUNDLED_GRANTS.writeReach;

/**
 * Studio's grant of `policy.readsFileAccessPosture`, which the provider cache key reads; the factory's borrow reads a
 * legacy engine's row as its record's `grants.readsFileAccessPosture`. Static because both decide while finding or
 * opening a provider, before one exists: the key carries the deny posture as a segment, so a denied and a full-reach
 * handle of one connection never share an entry, and the borrow lends a handle only to a caller of its own posture.
 */
export const GRANTED_READS_FILE_ACCESS_POSTURE: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.readsFileAccessPosture;

/**
 * Studio's grant of `policy.deniedFileAccessRefusal`, which MCP availability reads; the open check reads a legacy
 * engine's row as its record's `grants.deniedFileAccessRefusal`. A connection whose execution context denies file
 * access is refused with the sentence before Studio reads the path it names, and the provider raises it again at
 * `connect()`. Static because `list_connections` and `inspect_schema` decide before any provider exists.
 */
export const GRANTED_DENIED_FILE_ACCESS_REFUSAL: Readonly<Record<DatabaseType, string | null>> =
  BUNDLED_GRANTS.deniedFileAccessRefusal;

/**
 * Studio's grant of `policy.singleWriterFile`, which the provider cache key reads; the factory's borrow reads a legacy
 * engine's row as its record's `grants.singleWriterFile`. Static because the key decides before a provider exists:
 * under governance every user of a connection gets a provider of their own, and the key frames the user as its owner,
 * except on an engine granted a single-writer file, where a provider per user would be a second handle on one file.
 * The built provider's own `singleWriterFile` reaches no gate (clause M-57).
 */
export const GRANTED_SINGLE_WRITER_FILE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.singleWriterFile;

/**
 * Studio's grant of `policy.readRootsRequired`, which the seed schema, MCP, governance and agent runs read: the runs
 * route refuses an agent-mode Start whose workflow sends statements on a connection without read roots, the seed schema
 * refuses `mcp: true` without them, the MCP context refuses such a connection at open with `READ_ROOTS_REQUIRED`, and a
 * governed record, which carries no roots, is never opted in to MCP.
 */
export const GRANTED_READ_ROOTS_REQUIRED: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.readRootsRequired;

/**
 * Studio's grant of `policy.agentCredentialForm`, in the record's vocabulary, null for the user-and-password pair: every
 * agent acquisition reads a legacy engine's row as its record's `grants.agentCredentialForm`, before the provider it
 * built connects. It is not the seed agent credential, which is coarser: its `secret` covers both secret-only forms,
 * and its null covers both `none` and an engine that takes the pair at open but no agent credential on a seed.
 */
export const GRANTED_AGENT_CREDENTIAL_FORM: Readonly<Record<DatabaseType, AgentCredentialForm | null>> =
  BUNDLED_GRANTS.agentCredentialForm;

/**
 * Studio's grant of `policy.maskingExemptColumns`, which the producers of client capabilities answer in place of the
 * provider's own (`clientCapabilities` in ./client-capabilities), so a provider that declares a wider pattern than its
 * grant exempts nothing more. The embedded workspace and the published grid take the exemption from the embedder, and
 * this grant does not reach them.
 */
export const GRANTED_MASKING_EXEMPT_COLUMNS: Readonly<Record<DatabaseType, MaskingExemption>> =
  BUNDLED_GRANTS.maskingExemptColumns;

/**
 * Studio's grant of `mcp.exposable`, which the seed schema, governance and the MCP tools read: the seed schema refuses
 * `mcp: true` at load on an engine it does not grant, naming the engine, since the seed file is validated before any
 * provider exists.
 */
export const GRANTED_MCP_EXPOSABLE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.exposable;

/**
 * Studio's grant of `mcp.statementRead`, which the MCP statement tools read: a second claim beside exposure, which also
 * opens `list_connections` and `inspect_schema`. A statement tool serves an engine only where agent mode executes
 * statements on it, it is exposed and this grant is true (src/lib/mcp/tools/served-engines.ts), so an engine that joins
 * agent mode does not open to MCP as a side effect.
 */
export const GRANTED_MCP_STATEMENT_READ: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.statementRead;

/**
 * Studio's grant of `mcp.metadataReadChangesState`, which the MCP tool annotations read: true for an engine whose
 * metadata read changes state the engine keeps though it writes no data, so a token whose `tools/list` reaches one is
 * told `readOnlyHint: false` and `destructiveHint: false` on `inspect_schema` (`metadataReadAnnotations`). A grant per
 * engine rather than the provider's `resumesBilledCompute`, which `tools/list` cannot read before any provider exists.
 */
export const GRANTED_MCP_METADATA_READ_CHANGES_STATE: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.metadataReadChangesState;

/**
 * Studio's grant of `mcp.agentCredentialRequired`, which the seed schema, MCP and governance read: an engine MCP reads
 * only under the seed's own agent credential, whose grants bound what an MCP client reads, so the seed schema refuses
 * `mcp: true` without one at load and the MCP context refuses such a connection at open with
 * `AGENT_CREDENTIAL_REQUIRED`.
 */
export const GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.agentCredentialRequired;

/**
 * Which engines keep a read-only connection's promise: true exactly where the granted write reach is not `open`
 * (clause M-52): each legacy engine's record holds its row as `grants.readOnlyEnforced`, which `assertReadOnlyHonoured`
 * in src/lib/db/open-check.ts reads before anything is built or dialled.
 */
export const READ_ONLY_ENFORCED: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.readOnlyEnforced;

/**
 * The sentence every open of an engine is refused with where its claims leave a refusal no grant covers, null for every
 * other engine: each legacy engine's record holds its row as `grants.ungrantedRefusals`, which `assertClaimsGranted` in
 * src/lib/db/open-check.ts reads.
 */
export const UNGRANTED_CLAIM_REFUSALS: Readonly<Record<DatabaseType, string | null>> = BUNDLED_GRANTS.ungrantedRefusals;

/**
 * Studio's grant of `connection.opensLocalFile`, which the file admission of the legacy adapter's open
 * (`admittedFileConnection` in ./provider-files), governance and the VS Code backend read. A governance source never
 * grants such an engine (docs/GOVERNANCE.md#row-admission-and-skip-codes): row admission skips it as
 * ENGINE_UNSUPPORTED whatever `GOVERNANCE_ALLOWED_ENGINES` says, since a grant would hand its users a file of the host
 * Studio runs on. Static because admission decides from a row before any provider exists. The factory admits the file
 * such a connection names before the provider is built, refusing Studio's own storage files there, and hands the
 * provider the absolute path it admitted.
 */
export const GRANTED_OPENS_LOCAL_FILE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.opensLocalFile;

/**
 * Studio's grant of `connection.hostPathFields`, the fields the legacy adapter's open admits before a provider reads
 * one (`admittedHostPathConnection` in ./provider-files): each resolved against the working directory, refused by name
 * when it names one of Studio's own storage files, and handed to the provider as an absolute path under
 * `ADMITTED_HOST_PATHS` (`@/lib/types`). Kept apart from the local-file claim because that claim also decides
 * governance row admission, and an engine that reads a certificate from the host is still a server a governance source
 * may grant.
 */
export const GRANTED_HOST_PATH_FIELDS: Readonly<Record<DatabaseType, readonly HostPathField[]>> =
  BUNDLED_GRANTS.hostPathFields;

/**
 * Studio's grant of `connection.serverLevelWithoutDatabase` as governance admission reads it, restrictive when true:
 * a definition with no database of an engine it holds true for is never granted. Such an engine's provider declares
 * `catalogSessions` and opens a session of its own to each database the caller picks, so one credential reaches every
 * database it can sign in to, while a governance source grants one database per connection: row admission skips such a
 * definition as SERVER_LEVEL_NOT_ALLOWED (docs/GOVERNANCE.md#row-admission-and-skip-codes).
 */
export const GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.serverLevelAtAdmission;

/**
 * Studio's grant of `connection.serverLevelWithoutDatabase` as the choice of database reads it, restrictive when
 * false: `catalogChoice` honours a caller's choice of database only on an engine it holds true for (clause M-57), and
 * only where the connection names no database and no connection string, so it bounds the catalog sessions a provider
 * declares.
 */
export const GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.serverLevelAtCatalogChoice;

/**
 * Studio's grant of `connection.sshTunnel`, in the record's vocabulary: the sentence a tunnel that is on is refused
 * with, or null where the engine takes one. The provider's fields and the connection dialog read it; core's tunnel
 * decision reads a legacy engine's row as its record's `grants.sshTunnel`. Core decides a tunnel in `decideTunnel`
 * (./tunnel-decision) on every entry point before any cache lookup, bastion dial or provider build, so no provider
 * refuses a tunnel itself, and the dialog offers the SSH panel, and writes `sshTunnel`, exactly where the grant is null,
 * so the dialog and core cannot disagree. No review row's sentence quotes a value of the connection.
 */
export const GRANTED_SSH_TUNNEL_REFUSAL: Readonly<Record<DatabaseType, string | null>> = BUNDLED_GRANTS.sshTunnel;

/**
 * Studio's grant of `connection.agentCredential`: which agent credential a seed of each engine may carry, read by the
 * seed schema at load and by the seed projection's gates. Each superseding field of a review row is narrowed to the
 * engine's connection fields when this module loads, by `legacyAgentCredentials`.
 */
export const GRANTED_SEED_AGENT_CREDENTIAL: Readonly<Record<DatabaseType, SeedAgentCredential | null>> =
  BUNDLED_GRANTS.agentCredential;

/**
 * Studio's grant of `agent.statementLanguage`: the language agent mode sends the engine, or null where it sends none.
 * The agent posture, workflow availability, the classify route, the engine pack resolver, the agent rail and the MCP
 * served set and arms read it.
 */
export const GRANTED_AGENT_STATEMENT_LANGUAGE: Readonly<Record<DatabaseType, StatementLanguage>> =
  BUNDLED_GRANTS.statementLanguage;

/**
 * Studio's grant of `facets.agentReadings`: the curated readings agent mode is offered on the engine, in its facet
 * row's order. Whether the operations workflow opens in agent mode, the readings `inspect_operations` offers and
 * accepts, and the run ledger's reading check read it.
 */
export const GRANTED_AGENT_READINGS: Readonly<Record<DatabaseType, readonly AgentReading[]>> =
  BUNDLED_GRANTS.agentReadings;
