/**
 * What an agent's S3 read sends and answers: each read of the closed table (`agent-statement.ts`) run over the
 * agent's client (`S3AgentClient` in `client.ts`), its answer projected to names, counts and flags, and the wording of
 * a failure without the server's words.
 *
 * Each operation has a typed projection here, and the capability `metadataOnly` states them. No column's name comes
 * from the server, and no answer is passed on as it came: a bucket is its name, creation time, existence, region,
 * location and versioning status; a whole bucket is its object count and total size, which Studio adds up page by page
 * and never lists; an object is its existence, size, last-modified time and storage class, and never its key, ETag,
 * version id, user metadata, tags, content type or body. A cell that does not fit its column's kind refuses the whole
 * answer, as a stored value smuggled into a metadata field would look.
 *
 * Budgets refuse rather than cut: a bucket listing or a summary past the row budget, and an answer past the byte
 * budget, are refused, and a summary reads each page with the server's own continuation token, held here for the one
 * read and never returned, so nothing of one read reaches the next.
 */
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
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
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { S3AgentOperation, S3AgentPlan } from "./agent-statement";
import type { ObjectHead, S3AgentClient, S3CallOptions, VersioningState } from "./client";
import { S3_KEY_SCAN_MAX_COUNT, S3_MAX_BUCKETS_READ, S3_TYPE } from "./constants";
import { S3ServerError } from "./errors";

/** One bucket as the listing answers it. */
export interface S3AgentBucket {
  readonly name: string;
  /** ISO 8601; absent when the server gave none or the connection is pinned. */
  readonly created?: string;
}

/** One answer of the table's reads, as the provider hands it to its projection. */
export type S3AgentAnswer =
  | {
      readonly op: "list-buckets";
      readonly buckets: readonly S3AgentBucket[];
      /** The pinned bucket, answered with no request. */
      readonly pinned?: true;
      /** Names holding "/", which are counted and never listed. */
      readonly invalidNames?: number;
    }
  | { readonly op: "head-bucket"; readonly bucket: string; readonly exists: boolean; readonly region: string | null }
  | { readonly op: "get-bucket-location"; readonly bucket: string; readonly location: string }
  | { readonly op: "get-bucket-versioning"; readonly bucket: string; readonly state: VersioningState }
  | { readonly op: "summary"; readonly bucket: string; readonly objects: number; readonly bytes: number }
  | { readonly op: "head-object"; readonly bucket: string; readonly head: ObjectHead | undefined };

/** A server time as Studio's ISO form, or null for one it could not read, never the header's own text. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoOrNull = (time: string | null): string | null => (time !== null && ISO_TIME.test(time) ? time : null);
/** A storage class as S3 names one (STANDARD, STANDARD_IA, GLACIER_IR), or null, never other header text. */
const STORAGE_CLASS = /^[A-Z0-9_]{1,64}$/;
const storageClassOrNull = (value: string | null): string | null =>
  value !== null && STORAGE_CLASS.test(value) ? value : null;

const BUCKETS: MetadataProjection<S3AgentBucket> = [
  { column: "bucket", kind: "name", read: (b) => b.name },
  { column: "created", kind: "name", optional: true, read: (b) => b.created ?? null },
];

type HeadBucketAnswer = Extract<S3AgentAnswer, { op: "head-bucket" }>;
const HEAD_BUCKET: MetadataProjection<HeadBucketAnswer> = [
  { column: "bucket", kind: "name", read: (a) => a.bucket },
  { column: "exists", kind: "flag", read: (a) => a.exists },
  { column: "region", kind: "name", optional: true, read: (a) => a.region },
];

type LocationAnswer = Extract<S3AgentAnswer, { op: "get-bucket-location" }>;
const LOCATION: MetadataProjection<LocationAnswer> = [
  { column: "bucket", kind: "name", read: (a) => a.bucket },
  { column: "location", kind: "name", read: (a) => a.location },
];

type VersioningAnswer = Extract<S3AgentAnswer, { op: "get-bucket-versioning" }>;
const VERSIONING: MetadataProjection<VersioningAnswer> = [
  { column: "bucket", kind: "name", read: (a) => a.bucket },
  // No Status in the server's answer is its own statement that versioning was never enabled.
  { column: "status", kind: "name", read: (a) => a.state.status ?? "never enabled" },
  { column: "mfa_delete", kind: "name", optional: true, read: (a) => a.state.mfaDelete },
];

type SummaryAnswer = Extract<S3AgentAnswer, { op: "summary" }>;
const SUMMARY: MetadataProjection<SummaryAnswer> = [
  { column: "bucket", kind: "name", read: (a) => a.bucket },
  { column: "objects", kind: "count", read: (a) => a.objects },
  { column: "total_size_bytes", kind: "count", read: (a) => a.bytes },
];

/** The key a request names is not echoed: the answer is the bucket and the object's four facts. */
type HeadObjectAnswer = Extract<S3AgentAnswer, { op: "head-object" }>;
const HEAD_OBJECT: MetadataProjection<HeadObjectAnswer> = [
  { column: "bucket", kind: "name", read: (a) => a.bucket },
  { column: "exists", kind: "flag", read: (a) => a.head !== undefined },
  { column: "size_bytes", kind: "count", optional: true, read: (a) => a.head?.size ?? null },
  { column: "last_modified", kind: "name", optional: true, read: (a) => isoOrNull(a.head?.lastModified ?? null) },
  {
    column: "storage_class",
    kind: "name",
    optional: true,
    read: (a) => storageClassOrNull(a.head?.storageClass ?? null),
  },
];

const PROJECTIONS = Object.freeze({
  "list-buckets": BUCKETS,
  "head-bucket": HEAD_BUCKET,
  "get-bucket-location": LOCATION,
  "get-bucket-versioning": VERSIONING,
  summary: SUMMARY,
  "head-object": HEAD_OBJECT,
} satisfies Record<S3AgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for S3: every operation's columns and their kinds. */
export const S3_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

const NOT_PASSED_ON =
  "The server's own words are not passed on to agent mode, since an S3 error can repeat a key or a bucket the read did not name.";

export const S3_AGENT_FAILURE_SENTENCES = {
  denied: `The server refused this connection's key the read. ${NOT_PASSED_ON}`,
  missingBucket: `The bucket does not exist, or this connection's key may not see it. ${NOT_PASSED_ON}`,
  region: `The bucket is in another region than the one this connection signs for. ${NOT_PASSED_ON}`,
  unsupported: `The server does not implement this read. ${NOT_PASSED_ON}`,
  status: (status: number): string => `The server refused the read with HTTP ${status}. ${NOT_PASSED_ON}`,
  unreadable: `The server's answer to the read could not be read as the S3 metadata asked for. ${NOT_PASSED_ON}`,
  unreachable: `The server could not be reached for the read. ${NOT_PASSED_ON}`,
  tooLarge: `The server's answer to the read is larger than Studio reads for one request. ${NOT_PASSED_ON}`,
  closed: "The connection was closed while the read ran, so it was not answered.",
  bucketsCut: `The server holds more buckets than one listing answers (${S3_MAX_BUCKETS_READ.toLocaleString("en-US")}), so the listing was refused rather than answered in part.`,
  invalidBucketNames: (count: number): string =>
    `${count} bucket ${count === 1 ? "name holds" : "names hold"} a "/", which no S3 bucket name holds, so ${count === 1 ? "it is" : "they are"} counted here and not listed.`,
  summaryOverRows: (allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the bucket holds more than ${allowed} objects, and Studio counts a bucket's objects only up to the row budget, refusing a larger count rather than cutting it. A count over a prefix is not one of agent mode's reads, since it would reveal key names.`,
  repeatedToken:
    "The server sent the same continuation token twice, so reading on would count a page again: the summary was refused.",
  undecodable:
    "The bucket holds an object whose name is not text, which the server answers without its size, so Studio cannot total the bucket: the summary was refused rather than answered in part.",
  pinned:
    "This connection is pinned to one bucket, so no bucket listing was sent: the pinned bucket is answered, and its creation time is not read.",
  notFoundNote:
    "A HEAD that finds nothing does not say whether the key or the bucket is missing: read the bucket with aws s3api head-bucket to tell them apart.",
} as const;

/** What a read runs under: the request's budget, its call (the deadline and the session's end) and the pin. */
export interface S3AgentReadContext {
  readonly budget: ReadOnlyStatementBudget;
  readonly call: S3CallOptions;
  readonly pinnedBucket?: string;
}

const isNotFound = (error: unknown): error is S3ServerError =>
  error instanceof S3ServerError && error.status === 404 && error.problem === undefined;

/**
 * A whole bucket's object count and total size: every page of the bucket with no prefix and no delimiter, each asking
 * for at most what the row budget still allows, the keys of each page counted and dropped here. A bucket larger than
 * the budget is refused, never answered as the part read.
 */
async function summarize(client: S3AgentClient, bucket: string, context: S3AgentReadContext): Promise<SummaryAnswer> {
  const limit = context.budget.maxResultRows;
  const used = new Set<string>();
  let token: string | undefined;
  let objects = 0;
  let bytes = 0;
  for (;;) {
    const maxKeys = Math.min(S3_KEY_SCAN_MAX_COUNT, limit - objects);
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the continuation token of the page before it.
    const page = await client.listBucketPage(
      { bucket, maxKeys, ...(token === undefined ? {} : { continuationToken: token }) },
      context.call,
    );
    if (page.undecodable > 0) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.undecodable, S3_TYPE);
    // A whole-bucket page sent no delimiter, so a folder entry is an answer to another listing.
    if (page.prefixes.length > 0) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.unreadable, S3_TYPE);
    objects += page.keys.length;
    for (const listed of page.keys) bytes += listed.size;
    if (!page.isTruncated) return { op: "summary", bucket, objects, bytes };
    if (objects >= limit) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.summaryOverRows(limit), S3_TYPE);
    // The client refuses a truncated page with no token, so a truncated page has one.
    const next = page.nextToken as string;
    if (used.has(next)) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.repeatedToken, S3_TYPE);
    used.add(next);
    token = next;
  }
}

/** The answer of one admitted read, through the agent's client alone. */
export async function runS3AgentRead(
  client: S3AgentClient,
  plan: S3AgentPlan,
  context: S3AgentReadContext,
): Promise<S3AgentAnswer> {
  const { call } = context;
  switch (plan.op) {
    case "list-buckets": {
      if (context.pinnedBucket !== undefined)
        return { op: "list-buckets", buckets: [{ name: context.pinnedBucket }], pinned: true };
      const listing = await client.listBuckets(call);
      if (listing.truncated) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.bucketsCut, S3_TYPE);
      const allowed = context.budget.maxResultRows;
      if (listing.buckets.length > allowed)
        throw new QueryError(rowBudgetSentence(listing.buckets.length, allowed), S3_TYPE);
      return {
        op: "list-buckets",
        buckets: listing.buckets,
        ...(listing.invalidNames.length === 0 ? {} : { invalidNames: listing.invalidNames.length }),
      };
    }
    case "head-bucket":
      try {
        const head = await client.headBucket(plan.bucket, call);
        return { op: "head-bucket", bucket: plan.bucket, exists: true, region: head.bucketRegion };
      } catch (error) {
        if (isNotFound(error)) return { op: "head-bucket", bucket: plan.bucket, exists: false, region: null };
        throw error;
      }
    case "get-bucket-location":
      return { op: plan.op, bucket: plan.bucket, location: await client.getBucketLocation(plan.bucket, call) };
    case "get-bucket-versioning":
      return { op: plan.op, bucket: plan.bucket, state: await client.getBucketVersioning(plan.bucket, call) };
    case "summary":
      return summarize(client, plan.bucket, context);
    case "head-object":
      try {
        return { op: "head-object", bucket: plan.bucket, head: await client.headObject(plan.bucket, plan.key, call) };
      } catch (error) {
        // MinIO and its forks name a missing bucket in a header; any other 404 is a key the HEAD did not find.
        if (isNotFound(error) && error.code !== "NoSuchBucket")
          return { op: "head-object", bucket: plan.bucket, head: undefined };
        throw error;
      }
  }
}

/** The rows of one answer under its operation's projection, and the notes it carries. */
function project(answer: S3AgentAnswer): {
  readonly projected: ReturnType<typeof projectMetadata>;
  readonly warnings: readonly QueryWarning[];
} {
  switch (answer.op) {
    case "list-buckets": {
      const warnings: QueryWarning[] = [];
      if (answer.pinned === true) warnings.push({ message: S3_AGENT_FAILURE_SENTENCES.pinned });
      if (answer.invalidNames !== undefined)
        warnings.push({ message: S3_AGENT_FAILURE_SENTENCES.invalidBucketNames(answer.invalidNames) });
      return { projected: projectMetadata(BUCKETS, answer.buckets), warnings };
    }
    case "head-bucket":
      return { projected: projectMetadata(HEAD_BUCKET, [answer]), warnings: [] };
    case "get-bucket-location":
      return { projected: projectMetadata(LOCATION, [answer]), warnings: [] };
    case "get-bucket-versioning":
      return { projected: projectMetadata(VERSIONING, [answer]), warnings: [] };
    case "summary":
      return { projected: projectMetadata(SUMMARY, [answer]), warnings: [] };
    case "head-object":
      return {
        projected: projectMetadata(HEAD_OBJECT, [answer]),
        warnings: answer.head === undefined ? [{ message: S3_AGENT_FAILURE_SENTENCES.notFoundNote }] : [],
      };
  }
}

/** The answer of one read: its projected rows, refused past the byte budget rather than cut. */
export function s3AgentResult(
  answer: S3AgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const { projected, warnings } = project(answer);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), S3_TYPE, statement);
  }
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  };
}

/** A server's refusal by its status alone: never its message, code text, key, bucket or request id. */
function statusSentence(error: S3ServerError): string {
  if (error.problem !== undefined) return S3_AGENT_FAILURE_SENTENCES.unreadable;
  switch (error.status) {
    case 401:
    case 403:
      return S3_AGENT_FAILURE_SENTENCES.denied;
    case 404:
      return S3_AGENT_FAILURE_SENTENCES.missingBucket;
    case 301:
      return S3_AGENT_FAILURE_SENTENCES.region;
    case 501:
      return S3_AGENT_FAILURE_SENTENCES.unsupported;
    default:
      // A 2xx failure always carries its problem, worded above.
      return S3_AGENT_FAILURE_SENTENCES.status(error.status);
  }
}

/** A transport failure by its kind alone: its message can name the endpoint. */
const TRANSPORT_SENTENCES: Readonly<Record<Exclude<TransportError["kind"], "timeout">, string>> = Object.freeze({
  unreachable: S3_AGENT_FAILURE_SENTENCES.unreachable,
  tls: S3_AGENT_FAILURE_SENTENCES.unreachable,
  network: S3_AGENT_FAILURE_SENTENCES.unreachable,
  redirect: S3_AGENT_FAILURE_SENTENCES.region,
  encoding: S3_AGENT_FAILURE_SENTENCES.unreadable,
  "too-large": S3_AGENT_FAILURE_SENTENCES.tooLarge,
  aborted: S3_AGENT_FAILURE_SENTENCES.closed,
});

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is (Studio's own refusal, or a
 * defect). A server's or the transport's failure is worded by its category alone, never by its message, since an S3
 * error body can echo a key or a bucket the request did not hold and a transport message can name the endpoint; the
 * deadline and a permit wait it ended are the time budget's refusal, and an answer that fits no column is the
 * projection's own sentence.
 */
export function s3AgentFailure(
  error: unknown,
  budget: Pick<ReadOnlyStatementBudget, "statementTimeoutMs">,
  statement?: string,
): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, S3_TYPE, statement);
  const deadline =
    (error instanceof TransportError && error.kind === "timeout") ||
    (error instanceof DOMException && error.name === "TimeoutError");
  if (deadline) {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, S3_TYPE, statement);
  }
  if (error instanceof DOMException && error.name === "AbortError")
    return new QueryError(S3_AGENT_FAILURE_SENTENCES.closed, S3_TYPE, statement);
  if (error instanceof TransportError) {
    // A timeout was worded above, as the time budget's refusal.
    const kind = error.kind as Exclude<TransportError["kind"], "timeout">;
    return new QueryError(TRANSPORT_SENTENCES[kind], S3_TYPE, statement);
  }
  if (error instanceof S3ServerError) return new QueryError(statusSentence(error), S3_TYPE, statement);
  return undefined;
}
