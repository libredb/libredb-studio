/**
 * What an agent's etcd read answers: rows projected from the server's answer to names, counts and flags alone, and
 * the wording of a failure without etcd's words.
 *
 * Each operation of the closed table (`agent-statement.ts`) has a typed projection here, and the capability
 * `metadataOnly` states them. No column's name comes from the server, and no answer is passed on as it came: the key a
 * request names is not echoed, a value is reduced to its size in bytes, a member's addresses to how many there are, and
 * `Status.errors` to how many it holds. A cell that does not fit its column's kind refuses the whole answer, as a stored
 * value smuggled into a metadata field would look. The answers are those of
 * tests/fixtures/etcd/v3.7.2/agent-boundary/reader-range.json: 64-bit integers come as decimal strings, ids are shown
 * as etcdctl prints them (a member's `%x`, a lease's `%016x`), a lease of `TTL` -1 is one etcd no longer holds, and a
 * key with no lease holds lease 0.
 */
import { QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type {
  EtcdAlarm,
  EtcdAuthStatus,
  EtcdErrorCategory,
  EtcdKeyValue,
  EtcdLeaseTimeToLiveResponse,
  EtcdMember,
  EtcdStatus,
} from "./client";
import { EtcdError } from "./client";
import type { EtcdAgentOperation } from "./agent-statement";
import { leaseHexId, memberHexId } from "./keys";

/** One answer of the table's reads, as the provider hands it to its projection. */
export type EtcdAgentAnswer =
  | { readonly op: "endpoint status"; readonly status: EtcdStatus }
  | { readonly op: "member list"; readonly members: readonly EtcdMember[] }
  | { readonly op: "alarm list"; readonly alarms: readonly EtcdAlarm[] }
  | { readonly op: "auth status"; readonly auth: EtcdAuthStatus }
  | { readonly op: "lease list"; readonly ids: readonly string[] }
  | { readonly op: "lease timetolive"; readonly lease: EtcdLeaseTimeToLiveResponse }
  | { readonly op: "key count"; readonly count: string }
  | { readonly op: "key metadata"; readonly kv: EtcdKeyValue | undefined };

/** A non-negative 64-bit decimal as a number, or the text itself, which the projection then refuses. */
function countOf(decimal: unknown): unknown {
  return typeof decimal === "string" && /^\d{1,15}$/.test(decimal) ? Number(decimal) : decimal;
}

/**
 * What an id that is not one reads as: a value no column's kind admits, so the projection refuses the whole answer.
 * Never the text itself, which a `name` column would admit.
 */
const NOT_AN_ID = Symbol("not an id");

/** An id as etcdctl prints it, or `NOT_AN_ID`. */
function hexOf(decimal: unknown, write: (decimal: string) => string): unknown {
  if (typeof decimal !== "string") return NOT_AN_ID;
  try {
    return write(decimal);
  } catch {
    return NOT_AN_ID;
  }
}

/** etcd's quota as it answered: negative is a disabled quota, read as no quota. */
function quotaOf(decimal: string): unknown {
  return decimal.startsWith("-") ? null : countOf(decimal);
}

const STATUS: MetadataProjection<EtcdStatus> = [
  { column: "version", kind: "name", read: (status) => status.version },
  { column: "storage_version", kind: "name", optional: true, read: (status) => status.storageVersion || null },
  { column: "member_id", kind: "name", read: (status) => hexOf(status.header.memberId, memberHexId) },
  {
    column: "leader_id",
    kind: "name",
    optional: true,
    read: (status) => (status.leader === "0" ? null : hexOf(status.leader, memberHexId)),
  },
  { column: "is_learner", kind: "flag", read: (status) => status.isLearner },
  { column: "db_size_bytes", kind: "count", read: (status) => countOf(status.dbSize) },
  { column: "db_size_in_use_bytes", kind: "count", read: (status) => countOf(status.dbSizeInUse) },
  { column: "db_size_quota_bytes", kind: "count", optional: true, read: (status) => quotaOf(status.dbSizeQuota) },
  { column: "raft_term", kind: "count", read: (status) => countOf(status.raftTerm) },
  { column: "raft_index", kind: "count", read: (status) => countOf(status.raftIndex) },
  { column: "raft_applied_index", kind: "count", read: (status) => countOf(status.raftAppliedIndex) },
  { column: "errors", kind: "count", read: (status) => status.errors.length },
];

const MEMBER: MetadataProjection<EtcdMember> = [
  { column: "member_id", kind: "name", read: (member) => hexOf(member.id, memberHexId) },
  { column: "name", kind: "name", optional: true, read: (member) => member.name || null },
  { column: "is_learner", kind: "flag", read: (member) => member.isLearner },
  { column: "peer_urls", kind: "count", read: (member) => member.peerUrls.length },
  { column: "client_urls", kind: "count", read: (member) => member.clientUrls.length },
];

const ALARM: MetadataProjection<EtcdAlarm> = [
  { column: "member_id", kind: "name", read: (alarm) => hexOf(alarm.memberId, memberHexId) },
  { column: "alarm", kind: "name", read: (alarm) => alarm.alarm.toUpperCase() },
];

const AUTH: MetadataProjection<EtcdAuthStatus> = [
  { column: "enabled", kind: "flag", read: (auth) => auth.enabled },
  { column: "auth_revision", kind: "count", read: (auth) => countOf(auth.authRevision) },
];

const LEASE_ID: MetadataProjection<string> = [
  { column: "lease_id", kind: "name", read: (id) => hexOf(id, leaseHexId) },
];

const LEASE_TTL: MetadataProjection<EtcdLeaseTimeToLiveResponse> = [
  { column: "lease_id", kind: "name", read: (lease) => hexOf(lease.id, leaseHexId) },
  { column: "exists", kind: "flag", read: (lease) => lease.ttl !== "-1" },
  {
    column: "ttl_seconds",
    kind: "count",
    optional: true,
    read: (lease) => (lease.ttl === "-1" ? null : countOf(lease.ttl)),
  },
  {
    column: "granted_ttl_seconds",
    kind: "count",
    optional: true,
    read: (lease) => (lease.ttl === "-1" ? null : countOf(lease.grantedTtl)),
  },
];

const KEY_COUNT: MetadataProjection<string> = [{ column: "keys", kind: "count", read: countOf }];

/** One key's metadata: the key itself is never echoed, and its value is its size in bytes. */
const KEY_METADATA: MetadataProjection<EtcdKeyValue | undefined> = [
  { column: "exists", kind: "flag", read: (kv) => kv !== undefined },
  {
    column: "create_revision",
    kind: "count",
    optional: true,
    read: (kv) => (kv === undefined ? null : countOf(kv.createRevision)),
  },
  {
    column: "mod_revision",
    kind: "count",
    optional: true,
    read: (kv) => (kv === undefined ? null : countOf(kv.modRevision)),
  },
  { column: "version", kind: "count", optional: true, read: (kv) => (kv === undefined ? null : countOf(kv.version)) },
  {
    column: "lease_id",
    kind: "name",
    optional: true,
    read: (kv) => (kv === undefined || kv.lease === "0" ? null : hexOf(kv.lease, leaseHexId)),
  },
  { column: "value_bytes", kind: "count", optional: true, read: (kv) => (kv === undefined ? null : kv.value.length) },
];

const PROJECTIONS = Object.freeze({
  "endpoint status": STATUS,
  "member list": MEMBER,
  "alarm list": ALARM,
  "auth status": AUTH,
  "lease list": LEASE_ID,
  "lease timetolive": LEASE_TTL,
  "key count": KEY_COUNT,
  "key metadata": KEY_METADATA,
} satisfies Record<EtcdAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for etcd: every operation's columns and their kinds. */
export const ETCD_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The rows of one answer under its operation's projection. */
function project(answer: EtcdAgentAnswer): ReturnType<typeof projectMetadata> {
  switch (answer.op) {
    case "endpoint status":
      return projectMetadata(STATUS, [answer.status]);
    case "member list":
      return projectMetadata(MEMBER, answer.members);
    case "alarm list":
      return projectMetadata(ALARM, answer.alarms);
    case "auth status":
      return projectMetadata(AUTH, [answer.auth]);
    case "lease list":
      return projectMetadata(LEASE_ID, answer.ids);
    case "lease timetolive":
      return projectMetadata(LEASE_TTL, [answer.lease]);
    case "key count":
      return projectMetadata(KEY_COUNT, [answer.count]);
    case "key metadata":
      return projectMetadata(KEY_METADATA, [answer.kv]);
  }
}

/** The answer of one read: its projected rows, refused past the row or byte budget rather than cut. */
export function etcdAgentResult(
  answer: EtcdAgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const projected = project(answer);
  if (projected.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(projected.rows.length, budget.maxResultRows), "etcd", statement);
  }
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "etcd", statement);
  }
  return { fields: projected.fields, rows: projected.rows, rowCount: projected.rows.length, executionTime };
}

const NOT_PASSED_ON = "etcd's own words are not passed on to agent mode, since an etcd error can repeat a key.";

/** The wording of each failure the agent reads, by etcd's category alone. */
const FAILURES: Readonly<Partial<Record<EtcdErrorCategory, string>>> = Object.freeze({
  "permission-denied": `etcd refused the read: the agent's etcd user is not granted it, for example a key outside its READ ranges, or the count of every key for a user that may not read every key. ${NOT_PASSED_ON}`,
  "lease-not-found": `etcd holds no lease with that id. ${NOT_PASSED_ON}`,
  "no-leader": `The etcd member this connection reaches has no leader, so the cluster has lost quorum and the read was not answered. ${NOT_PASSED_ON}`,
  unauthenticated: `etcd did not accept this connection's sign-in for the read. ${NOT_PASSED_ON}`,
  "resource-exhausted": `etcd's answer to the read is larger than this connection's receive cap. ${NOT_PASSED_ON}`,
});

export const ETCD_AGENT_FAILURE_SENTENCES = {
  /** `category` is one of the client's own categories, never server text. */
  refused: (category: EtcdErrorCategory): string =>
    FAILURES[category] ?? `etcd did not answer the read (${category}). ${NOT_PASSED_ON}`,
} as const;

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is (a refusal raised before
 * anything was sent, or a defect). An etcd failure is worded by its category alone, a deadline is the time budget's
 * refusal, and an answer that fits no column is the projection's own sentence.
 */
export function etcdAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, "etcd", statement);
  if (!(error instanceof EtcdError)) return undefined;
  if (error.category === "deadline-exceeded") {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, "etcd", statement);
  }
  return new QueryError(ETCD_AGENT_FAILURE_SENTENCES.refused(error.category), "etcd", statement);
}
