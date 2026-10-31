/**
 * What an agent's Oxia read answers: rows projected from the server's answer to names, counts and flags alone, and the
 * wording of a failure without Oxia's words.
 *
 * Each operation of the closed table (`agent-statement.ts`) has a typed projection here, and the capability
 * `metadataOnly` states them. No column's name comes from the server, and no answer is passed on as it came: the key a
 * request names is not echoed, a value is reduced to its size in bytes, an ephemeral record's session id and client
 * identity to one flag, the shard map to its shard and leader counts, and the keys of a counted range to how many there
 * are. A cell that does not fit its column's kind refuses the whole answer, as a stored value smuggled into a metadata
 * field would look. The answers are those of tests/fixtures/oxia/0.18.0/agent-boundary/open.json: 64-bit integers come
 * as decimal strings and timestamps as epoch milliseconds.
 */
import { QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
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
import type { OxiaAgentOperation } from "./agent-statement";
import type { OxiaRecordView, OxiaSnapshot } from "./client";
import { OXIA_RUN_BYTE_BUDGET, OXIA_TYPE } from "./constants";
import { type OxiaErrorCategory, OxiaError } from "./errors";
import { isoFromEpochMs } from "./values";

/** One answer of the table's reads, as the provider hands it to its projection. */
export type OxiaAgentAnswer =
  | { readonly op: "shards"; readonly snapshot: OxiaSnapshot }
  | { readonly op: "key metadata"; readonly record: OxiaRecordView | undefined }
  | { readonly op: "key count"; readonly count: number };

/** A non-negative 64-bit decimal as a number, or the text itself, which the projection then refuses. */
function countOf(decimal: unknown): unknown {
  return typeof decimal === "string" && /^\d{1,15}$/.test(decimal) ? Number(decimal) : decimal;
}

/** An epoch-milliseconds timestamp as an ISO time, or a value no column's kind admits, so the answer is refused. */
function timeOf(decimal: string): unknown {
  try {
    return isoFromEpochMs(decimal);
  } catch {
    return Symbol("not a time");
  }
}

const SHARDS: MetadataProjection<OxiaSnapshot> = [
  { column: "namespace", kind: "name", read: (snapshot) => snapshot.namespace },
  { column: "shards", kind: "count", read: (snapshot) => snapshot.shards.length },
  {
    column: "leaders",
    kind: "count",
    read: (snapshot) => new Set(snapshot.shards.map((shard) => shard.leader.address)).size,
  },
];

/**
 * One key's metadata: the key itself is never echoed, its value is its size in bytes (absent when the value is larger
 * than the receive cap and was withheld), and an ephemeral record's session id and client identity are one flag.
 */
const KEY_METADATA: MetadataProjection<OxiaRecordView | undefined> = [
  { column: "exists", kind: "flag", read: (record) => record !== undefined },
  {
    column: "version_id",
    kind: "count",
    optional: true,
    read: (record) => (record === undefined ? null : countOf(record.version.versionId)),
  },
  {
    column: "modifications",
    kind: "count",
    optional: true,
    read: (record) => (record === undefined ? null : countOf(record.version.modificationsCount)),
  },
  {
    column: "created",
    kind: "name",
    optional: true,
    read: (record) => (record === undefined ? null : timeOf(record.version.createdTimestamp)),
  },
  {
    column: "modified",
    kind: "name",
    optional: true,
    read: (record) => (record === undefined ? null : timeOf(record.version.modifiedTimestamp)),
  },
  {
    column: "value_bytes",
    kind: "count",
    optional: true,
    // A value withheld at the receive cap is absent from the record, so it has no size.
    read: (record) => (record === undefined ? null : (record.value?.length ?? null)),
  },
  {
    column: "ephemeral",
    kind: "flag",
    optional: true,
    read: (record) => (record === undefined ? null : record.version.sessionId !== undefined),
  },
];

const KEY_COUNT: MetadataProjection<number> = [{ column: "keys", kind: "count", read: (count) => count }];

const PROJECTIONS = Object.freeze({
  shards: SHARDS,
  "key metadata": KEY_METADATA,
  "key count": KEY_COUNT,
} satisfies Record<OxiaAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for Oxia: every operation's columns and their kinds. */
export const OXIA_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The rows of one answer under its operation's projection. */
function project(answer: OxiaAgentAnswer): ReturnType<typeof projectMetadata> {
  switch (answer.op) {
    case "shards":
      return projectMetadata(SHARDS, [answer.snapshot]);
    case "key metadata":
      return projectMetadata(KEY_METADATA, [answer.record]);
    case "key count":
      return projectMetadata(KEY_COUNT, [answer.count]);
  }
}

/** The answer of one read: its projected rows, refused past the row or byte budget rather than cut. */
export function oxiaAgentResult(
  answer: OxiaAgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const projected = project(answer);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), OXIA_TYPE, statement);
  }
  return { fields: projected.fields, rows: projected.rows, rowCount: projected.rows.length, executionTime };
}

const NOT_PASSED_ON = "Oxia's own words are not passed on to agent mode, since an Oxia error can repeat a key.";

const MEBIBYTES = OXIA_RUN_BYTE_BUDGET / (1024 * 1024);

export const OXIA_AGENT_COUNT_SENTENCES = {
  /**
   * A count Studio stopped past the row budget: the keys are counted in Studio and never listed, so a count larger
   * than the budget is refused rather than answered as the budget.
   */
  overRows: (allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the namespace holds more than ${allowed} keys, and Studio counts its keys only up to the row budget, refusing a larger count rather than cutting it. A count over a narrower range is not one of agent mode's reads, since it would reveal key names.`,
  /** A count Studio stopped at the run's byte budget before it reached the end of the namespace. */
  overBytes: `The namespace's keys are longer than the ${MEBIBYTES} MiB Studio reads to count them, so the count was refused rather than cut.`,
  /** A key several shards hold under different partition keys: no one record answers for it. */
  manyHolders: (shards: number): string =>
    `That key is stored on ${shards} shards under different partition keys, so no one record answers for it, and agent mode reads no partition key. ${NOT_PASSED_ON}`,
} as const;

/** The wording of each failure the agent reads, by Oxia's category alone. */
const FAILURES: Readonly<Partial<Record<OxiaErrorCategory, string>>> = Object.freeze({
  unauthenticated: `Oxia did not accept this connection's token for the read. ${NOT_PASSED_ON}`,
  "namespace-not-found": `Oxia does not serve this connection's namespace. ${NOT_PASSED_ON}`,
  "receive-cap": `Oxia's answer to the read is larger than this connection's receive cap. ${NOT_PASSED_ON}`,
  "not-leader": `The shard's leader moved while the read ran, so it was not answered: run it again. ${NOT_PASSED_ON}`,
  "leader-changing": `The shard's leader moved while the read ran, so it was not answered: run it again. ${NOT_PASSED_ON}`,
  "shard-not-found": `The shard map moved while the read ran, so it was not answered: run it again. ${NOT_PASSED_ON}`,
  "record-changed": `The record changed while the read ran, so it was not answered: run it again. ${NOT_PASSED_ON}`,
});

export const OXIA_AGENT_FAILURE_SENTENCES = {
  /** `category` is one of the client's own categories, never server text. */
  refused: (category: OxiaErrorCategory): string =>
    FAILURES[category] ?? `Oxia did not answer the read (${category}). ${NOT_PASSED_ON}`,
} as const;

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is (a refusal raised before
 * anything was sent, or a defect). An Oxia failure is worded by its category alone, a deadline or a permit wait the
 * deadline ended is the time budget's refusal, and an answer that fits no column is the projection's own sentence.
 */
export function oxiaAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, OXIA_TYPE, statement);
  const deadline =
    (error instanceof OxiaError && error.category === "deadline-exceeded") ||
    (error instanceof DOMException && error.name === "TimeoutError");
  if (deadline) {
    return new QueryError(
      `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
      OXIA_TYPE,
      statement,
    );
  }
  if (!(error instanceof OxiaError)) return undefined;
  return new QueryError(OXIA_AGENT_FAILURE_SENTENCES.refused(error.category), OXIA_TYPE, statement);
}
