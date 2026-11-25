/**
 * Studio's grant of each policy and MCP claim an engine declaration requests (docs/providers/CONTRACT.md, clauses M-54
 * and M-82): the one module that reads a request, `BUNDLED_CLAIM_REQUESTS`, and Studio's review record of each claim,
 * and the module every gate reads in their place.
 *
 * A claim is a request, never a fact Studio believes as declared (clause M-52). So each claim is granted as the more
 * restrictive of the engine's request and the row of Studio's record, and at the claim's restrictive value (clause
 * M-53) where the record holds no row, one rule per claim shape:
 * - `writeReach`, ordered `open`, `guarded`, `none` from the most restrictive: the more restrictive of the two, `open`
 *   where no row exists. `READ_ONLY_ENFORCED` is true exactly where the granted write reach is not `open`.
 * - `readsFileAccessPosture`, `readRootsRequired`, `metadataReadChangesState` and `agentCredentialRequired`,
 *   restrictive when true: true where the request or the row is, or no row exists.
 * - `exposable` and `statementRead`, restrictive when false: true only where the request and the row both are. An
 *   engine read as requiring an agent credential whose seeds take none, its `SEED_AGENT_CREDENTIAL` row null or absent,
 *   is closed to MCP whatever its exposure request and row (clause M-55).
 * - `deniedFileAccessRefusal`, restrictive as a refusal: a request that refuses keeps its own sentence, a request of
 *   null takes the row's refusal, and takes `UNGRANTED_DENIED_FILE_ACCESS_SENTENCE`, core's own, where no row exists.
 * - `singleWriterFile`, where neither value is restrictive, since a second read-write handle on a single-writer file
 *   and one handle shared between users both overreach: the row where the request equals it, false where no row exists;
 *   any other request leaves the engine refused at every open with `UNGRANTED_SINGLE_WRITER_FILE_SENTENCE`, which
 *   `UNGRANTED_CLAIM_REFUSALS` holds and the factory's `assertClaimsGranted` raises before anything is touched.
 * - `agentCredentialForm`, unordered: the row where the request equals it, the record's null row read as `pair`, and
 *   `none` otherwise or where no row exists. The granted table keeps the record's vocabulary, null for the pair.
 * - `maskingExemptColumns`, unordered: the row where the request equals it, column pattern and reason, and null
 *   otherwise or where no row exists.
 * A record's row is looked up as an own property, so a key on the prototype chain is no row. A request value outside
 * its claim's vocabulary is refused by name, naming the claim and the engine, never read at a default.
 *
 * The records stay Studio's hand-written tables in src/lib/db/compatibility.ts and src/lib/db/connection-fields.ts,
 * which import nothing of this module; tests/unit/db/claim-record-readers.test.ts holds that no other module of
 * Studio's source reads them, and tests/unit/db/engine-declaration-readers.test.ts that no other module reads a
 * request. For every engine Studio ships each request is its record's row, so each granted table equals its record
 * there.
 *
 * The tables are computed once, when this module loads, over the bundled declarations; a loader that admits a provider
 * package computes `grantClaims` over its admitted set the same way. The module holds literals and generated data only,
 * so the browser's readers, the read-only marker and the connection form, load it as they load the records.
 */
import type { AgentCredentialFormClaim, McpClaims, PolicyClaims } from "@libredb/provider-sdk/manifest";
import type { DatabaseType } from "@/lib/types";
import {
  MASKING_EXEMPT_COLUMNS,
  MCP_AGENT_CREDENTIAL_REQUIRED,
  MCP_EXPOSABLE,
  MCP_METADATA_READ_CHANGES_STATE,
  MCP_STATEMENT_READ,
  READ_ROOTS_REQUIRED,
  READS_FILE_ACCESS_POSTURE,
  REFUSES_DENIED_FILE_ACCESS,
  SINGLE_WRITER_FILE,
  WRITE_REACH,
} from "./compatibility";
import { AGENT_CREDENTIAL_FORM, SEED_AGENT_CREDENTIAL, type SeedAgentCredential } from "./connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "./engine-catalog/claims.generated";
import type { ClaimRequestEntry } from "./engine-catalog/projection";
import type { AgentCredentialForm, ProviderCapabilities } from "./types";
import type { WriteReach } from "./write-reach";

/** A masking exemption as Studio's record holds it: a column pattern and a reason, or null. */
type MaskingExemption = NonNullable<ProviderCapabilities["maskingExemptColumns"]> | null;

/** One record of Studio's, keyed by engine id; an id it holds no row for is read at the claim's restrictive value. */
type Rows<T> = Readonly<Record<string, T>>;

/**
 * Studio's review record of each policy and MCP claim, keyed by the member that requests it, and the seed agent
 * credential record M-55's MCP reading reads beside them.
 */
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
  readonly seedAgentCredential: Rows<SeedAgentCredential | null>;
}

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
}

/** Studio's records, as `grantClaims` reads them for the bundled declarations. */
export const STUDIO_CLAIM_RECORDS: ClaimRecords = Object.freeze({
  writeReach: WRITE_REACH,
  readsFileAccessPosture: READS_FILE_ACCESS_POSTURE,
  deniedFileAccessRefusal: REFUSES_DENIED_FILE_ACCESS,
  singleWriterFile: SINGLE_WRITER_FILE,
  readRootsRequired: READ_ROOTS_REQUIRED,
  agentCredentialForm: AGENT_CREDENTIAL_FORM,
  maskingExemptColumns: MASKING_EXEMPT_COLUMNS,
  exposable: MCP_EXPOSABLE,
  statementRead: MCP_STATEMENT_READ,
  metadataReadChangesState: MCP_METADATA_READ_CHANGES_STATE,
  agentCredentialRequired: MCP_AGENT_CREDENTIAL_REQUIRED,
  seedAgentCredential: SEED_AGENT_CREDENTIAL,
});

/** Core's sentence for a connection whose file access is denied, on an engine Studio holds no refusal row for. */
export const UNGRANTED_DENIED_FILE_ACCESS_SENTENCE =
  "Connections of this engine require an administrator because Studio holds no grant that its provider confines file access for a caller whose file access is denied";

/** The sentence every open of an engine whose single-writer file request is not its grant is refused with. */
export const UNGRANTED_SINGLE_WRITER_FILE_SENTENCE =
  "Studio opens no connection of this engine because its request for how many handles one file may hold is not the one Studio granted, and a second read-write handle on one file can lose committed rows";

/** Refuses `value`, requested by `engine` at `claim`, as outside the claim's vocabulary. */
function refused(engine: string, claim: string, value: unknown): never {
  throw new Error(`${engine} requests ${claim} ${JSON.stringify(value)}, which is not a value of the claim`);
}

/** `value` as a boolean request, or refused by name. */
function booleanRequest(engine: string, claim: string, value: unknown): boolean {
  if (typeof value !== "boolean") refused(engine, claim, value);
  return value;
}

/** The rank of a write reach from the most restrictive, `open` 0, or refused by name. */
function writeReachRank(engine: string, value: unknown): number {
  switch (value) {
    case "open":
      return 0;
    case "guarded":
      return 1;
    case "none":
      return 2;
  }
  return refused(engine, "policy.writeReach", value);
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
  const reach = Math.min(
    writeReachRank(engine, policy.writeReach),
    writeReachRank(engine, rowOf(records.writeReach, engine, "open")),
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

/** The grant of every claim `requested` by `engine`, against `records`. */
function grantEngine(engine: string, requested: ClaimRequestEntry, records: ClaimRecords): EngineGrant {
  const policy = grantPolicy(engine, requested.policy, records);
  const mcp: McpClaims = requested.mcp;
  const agentCredentialRequired = grantedTrue(
    engine,
    "mcp.agentCredentialRequired",
    mcp.agentCredentialRequired,
    records.agentCredentialRequired,
  );
  const exposed = grantedFalse(engine, "mcp.exposable", mcp.exposable, records.exposable);
  const seedsTakeNone = rowOf(records.seedAgentCredential, engine, null) === null;
  return {
    writeReach: policy.writeReach,
    readsFileAccessPosture: policy.readsFileAccessPosture,
    deniedFileAccessRefusal: policy.deniedFileAccessRefusal,
    singleWriterFile: policy.singleWriterFile,
    readRootsRequired: policy.readRootsRequired,
    agentCredentialForm: policy.agentCredentialForm,
    maskingExemptColumns: policy.maskingExemptColumns,
    exposable: exposed && !(agentCredentialRequired && seedsTakeNone),
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
];

/**
 * Studio's grant of every policy and MCP claim `requests` holds, against `records`: one frozen table per claim, keyed
 * by the requests' engines in their order, each row frozen.
 *
 * @throws {Error} Naming the engine, the claim and the value, for a request value outside its claim's vocabulary.
 */
export function grantClaims<K extends string>(
  requests: Readonly<Record<K, ClaimRequestEntry>>,
  records: ClaimRecords,
): ClaimGrants<K> {
  const engines = Object.keys(requests) as K[];
  const grants = engines.map((engine) => [engine, grantEngine(engine, requests[engine], records)] as const);
  return Object.freeze(
    Object.fromEntries(
      GRANT_MEMBERS.map((member) => [
        member,
        Object.freeze(Object.fromEntries(grants.map(([engine, grant]) => [engine, grant[member]]))),
      ]),
    ),
  ) as unknown as ClaimGrants<K>;
}

/** Studio's grant of every bundled declaration's claims. */
const BUNDLED_GRANTS = grantClaims(BUNDLED_CLAIM_REQUESTS, STUDIO_CLAIM_RECORDS);

/** Studio's grant of `policy.writeReach`, which the seed schema and the connection form read. */
export const GRANTED_WRITE_REACH: Readonly<Record<DatabaseType, WriteReach>> = BUNDLED_GRANTS.writeReach;

/** Studio's grant of `policy.readsFileAccessPosture`, which the provider cache key and the borrow read. */
export const GRANTED_READS_FILE_ACCESS_POSTURE: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.readsFileAccessPosture;

/** Studio's grant of `policy.deniedFileAccessRefusal`, which the factory and MCP availability read. */
export const GRANTED_DENIED_FILE_ACCESS_REFUSAL: Readonly<Record<DatabaseType, string | null>> =
  BUNDLED_GRANTS.deniedFileAccessRefusal;

/** Studio's grant of `policy.singleWriterFile`, which the factory's borrow and the provider cache key read. */
export const GRANTED_SINGLE_WRITER_FILE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.singleWriterFile;

/** Studio's grant of `policy.readRootsRequired`, which the seed schema, MCP, governance and agent runs read. */
export const GRANTED_READ_ROOTS_REQUIRED: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.readRootsRequired;

/** Studio's grant of `policy.agentCredentialForm`, in the record's vocabulary, which every agent acquisition reads. */
export const GRANTED_AGENT_CREDENTIAL_FORM: Readonly<Record<DatabaseType, AgentCredentialForm | null>> =
  BUNDLED_GRANTS.agentCredentialForm;

/** Studio's grant of `policy.maskingExemptColumns`, which the producers of client capabilities answer. */
export const GRANTED_MASKING_EXEMPT_COLUMNS: Readonly<Record<DatabaseType, MaskingExemption>> =
  BUNDLED_GRANTS.maskingExemptColumns;

/** Studio's grant of `mcp.exposable`, which the seed schema, governance and the MCP tools read. */
export const GRANTED_MCP_EXPOSABLE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.exposable;

/** Studio's grant of `mcp.statementRead`, which the MCP statement tools read. */
export const GRANTED_MCP_STATEMENT_READ: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.statementRead;

/** Studio's grant of `mcp.metadataReadChangesState`, which the MCP tool annotations read. */
export const GRANTED_MCP_METADATA_READ_CHANGES_STATE: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.metadataReadChangesState;

/** Studio's grant of `mcp.agentCredentialRequired`, which the seed schema, MCP and governance read. */
export const GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED: Readonly<Record<DatabaseType, boolean>> =
  BUNDLED_GRANTS.agentCredentialRequired;

/**
 * Which engines keep a read-only connection's promise: true exactly where the granted write reach is not `open`
 * (clause M-52), which `assertReadOnlyHonoured` in src/lib/db/factory.ts reads before anything is built or dialled.
 */
export const READ_ONLY_ENFORCED: Readonly<Record<DatabaseType, boolean>> = BUNDLED_GRANTS.readOnlyEnforced;

/**
 * The sentence every open of an engine is refused with where its claims leave a refusal no grant covers, null for every
 * other engine, which `assertClaimsGranted` in src/lib/db/factory.ts reads.
 */
export const UNGRANTED_CLAIM_REFUSALS: Readonly<Record<DatabaseType, string | null>> = BUNDLED_GRANTS.ungrantedRefusals;
