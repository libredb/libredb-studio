/**
 * What an agent's Redis read answers: one row per read, projected from the server's reply to names, counts and flags
 * alone, and the wording of a failure without the server's words, since a Redis error can repeat a key.
 *
 * Each operation of the closed table (`redis-agent-statement.ts`) has a typed projection here, and the capability
 * `metadataOnly` states them. No column's name comes from the server, and no reply is passed on as it came: the key a
 * request names is not echoed in its answer, and a reply that does not fit its column's kind refuses the whole answer,
 * as a stored value smuggled into a metadata field would look. The replies are those of
 * tests/fixtures/redis/<version>/agent-boundary/reader-info.json: integers come as digit strings (`stringNumbers`),
 * `TTL` answers -2 for a missing key and -1 for one with no expiry, and `OBJECT ENCODING` and `MEMORY USAGE` answer
 * nil for a missing key.
 */
import { QueryError } from "@/lib/db/errors";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { RedisAgentOperation } from "./redis-agent-statement";

/** An integer reply as a number, or undefined when it is not one. */
function integerOf(reply: unknown): number | undefined {
  if (typeof reply === "number") return Number.isSafeInteger(reply) ? reply : undefined;
  if (typeof reply !== "string" || !/^-?\d{1,15}$/.test(reply)) return undefined;
  return Number(reply);
}

/** A non-negative integer reply, or the reply itself, which the projection then refuses. */
function countOf(reply: unknown): unknown {
  return integerOf(reply) ?? reply;
}

/** `EXISTS`'s 1 or 0 as a flag, or the reply itself, which the projection then refuses. */
function flagOf(reply: unknown): unknown {
  const value = integerOf(reply);
  return value === 1 ? true : value === 0 ? false : reply;
}

/** A time to live: -2 is no key, -1 a key with no expiry, any other value its remaining time. */
function ttlProjection(column: string): MetadataProjection<unknown> {
  return [
    {
      column: "exists",
      kind: "flag",
      read: (reply) => (integerOf(reply) === undefined ? reply : integerOf(reply) !== -2),
    },
    {
      column: "expires",
      kind: "flag",
      read: (reply) => {
        const value = integerOf(reply);
        return value === undefined ? reply : value >= 0;
      },
    },
    {
      column,
      kind: "count",
      optional: true,
      read: (reply) => {
        const value = integerOf(reply);
        return value === -1 || value === -2 ? null : countOf(reply);
      },
    },
  ];
}

const LENGTH: MetadataProjection<unknown> = [{ column: "length", kind: "count", read: countOf }];

const PROJECTIONS: Readonly<Record<RedisAgentOperation, MetadataProjection<unknown>>> = Object.freeze({
  DBSIZE: [{ column: "keys", kind: "count", read: countOf }],
  TYPE: [{ column: "type", kind: "name", read: (reply) => reply }],
  EXISTS: [{ column: "exists", kind: "flag", read: flagOf }],
  TTL: ttlProjection("ttl_seconds"),
  PTTL: ttlProjection("ttl_milliseconds"),
  STRLEN: LENGTH,
  LLEN: LENGTH,
  HLEN: LENGTH,
  SCARD: LENGTH,
  ZCARD: LENGTH,
  XLEN: LENGTH,
  "OBJECT ENCODING": [{ column: "encoding", kind: "name", optional: true, read: (reply) => reply }],
  "MEMORY USAGE": [{ column: "bytes", kind: "count", optional: true, read: countOf }],
});

/** What `ProviderCapabilities.metadataOnly` states for Redis: every operation's columns and their kinds. */
export const REDIS_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The answer of one read: its one projected row, refused past the row or byte budget rather than cut. */
export function redisAgentResult(
  op: RedisAgentOperation,
  reply: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const projected = projectMetadata(PROJECTIONS[op], [reply]);
  if (projected.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(projected.rows.length, budget.maxResultRows), "redis", statement);
  }
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "redis", statement);
  }
  return { fields: projected.fields, rows: projected.rows, rowCount: projected.rows.length, executionTime };
}

/** The error codes a Redis error line may begin with that the agent's wording names; any other is "an error". */
const NAMED_CODES: ReadonlySet<string> = new Set([
  "ERR",
  "WRONGTYPE",
  "NOPERM",
  "LOADING",
  "BUSY",
  "MASTERDOWN",
  "MISCONF",
  "READONLY",
  "OOM",
  "CLUSTERDOWN",
  "MOVED",
  "ASK",
  "TRYAGAIN",
  "NOAUTH",
]);

const NOT_PASSED_ON =
  "The server's own words are not passed on to agent mode, since a Redis error can repeat a key or a value.";

export const REDIS_AGENT_FAILURE_SENTENCES = {
  wrongType: `The key holds a value of another type than this read measures: read its TYPE first, then the length read of that type. ${NOT_PASSED_ON}`,
  noPerm: `The agent's ACL user may not read the key this request names. ${NOT_PASSED_ON}`,
  /** `code` is one of `NAMED_CODES`, or none. */
  refused: (code: string | undefined): string =>
    `Redis refused the read${code === undefined ? "" : ` with ${code}`}. ${NOT_PASSED_ON}`,
} as const;

/** The first word of an error line, when it is a code the wording names. */
function codeOf(message: string): string | undefined {
  const match = /^([A-Z]{2,12}) /.exec(message);
  return match !== null && NAMED_CODES.has(match[1]) ? match[1] : undefined;
}

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is (a refused connect, whose
 * words name the host and the credential's fate, never a key). A server's error line is worded by its code alone, a
 * deadline is the time budget's refusal, and a reply that fits no column is the projection's own sentence.
 */
export function redisAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, "redis", statement);
  if (!(error instanceof Error)) return undefined;
  if (error.message === "Command timed out") {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, "redis", statement);
  }
  if (error.name !== "ReplyError") return undefined;
  const code = codeOf(error.message);
  const message =
    code === "WRONGTYPE"
      ? REDIS_AGENT_FAILURE_SENTENCES.wrongType
      : code === "NOPERM"
        ? REDIS_AGENT_FAILURE_SENTENCES.noPerm
        : REDIS_AGENT_FAILURE_SENTENCES.refused(code);
  return new QueryError(message, "redis", statement);
}
