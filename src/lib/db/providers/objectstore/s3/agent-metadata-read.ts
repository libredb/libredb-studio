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
import {
  S3_AGENT_BUCKET_CHECK_CONCURRENCY,
  S3_AGENT_BUCKET_CHECK_MAX,
  S3_KEY_SCAN_MAX_COUNT,
  S3_MAX_BUCKETS_READ,
  S3_TYPE,
} from "./constants";
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
      /** Listed buckets whose HEAD the server did not answer for this key, which are counted and never named. */
      readonly withheld?: number;
    }
  | { readonly op: "head-bucket"; readonly bucket: string; readonly exists: true; readonly region: string | null }
  | { readonly op: "get-bucket-location"; readonly bucket: string; readonly location: string }
  | { readonly op: "get-bucket-versioning"; readonly bucket: string; readonly state: VersioningState }
  | { readonly op: "summary"; readonly bucket: string; readonly objects: number; readonly bytes: number }
  | { readonly op: "head-object"; readonly bucket: string; readonly head: ObjectHead };

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
  { column: "exists", kind: "flag", read: () => true },
  { column: "size_bytes", kind: "count", optional: true, read: (a) => a.head.size },
  { column: "last_modified", kind: "name", optional: true, read: (a) => isoOrNull(a.head.lastModified) },
  { column: "storage_class", kind: "name", optional: true, read: (a) => storageClassOrNull(a.head.storageClass) },
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
  notFound: `The bucket or the key does not exist, or this connection's key may not read it: agent mode answers each of these alike, so a read never tells which. ${NOT_PASSED_ON}`,
  region: `The bucket is in another region than the one this connection signs for. ${NOT_PASSED_ON}`,
  unsupported: `The server does not implement this read. ${NOT_PASSED_ON}`,
  status: (status: number): string => `The server refused the read with HTTP ${status}. ${NOT_PASSED_ON}`,
  unreadable: `The server's answer to the read could not be read as the S3 metadata asked for. ${NOT_PASSED_ON}`,
  unreachable: `The server could not be reached for the read. ${NOT_PASSED_ON}`,
  tooLarge: `The server's answer to the read is larger than Studio reads for one request. ${NOT_PASSED_ON}`,
  closed: "The connection was closed while the read ran, so it was not answered.",
  bucketsCut: `The server holds more buckets than one listing answers (${S3_MAX_BUCKETS_READ.toLocaleString("en-US")}), so the listing was refused rather than answered in part.`,
  withheldBuckets: (count: number): string =>
    `${count} listed ${count === 1 ? "bucket is" : "buckets are"} not named: a HEAD of ${count === 1 ? "it" : "each"} signed with this connection's key was refused, or answered that it is missing or in another region, so the server's grants do not show this key may read ${count === 1 ? "it" : "them"}.`,
  bucketChecksOver: (listed: number): string =>
    `This key lists ${listed.toLocaleString("en-US")} buckets, more than the ${S3_AGENT_BUCKET_CHECK_MAX} agent mode checks against the key's grants for one listing, one HEAD each, so the listing was refused rather than answered in part or sent more checks. Read a bucket you name with head-bucket, or pin the connection to one bucket.`,
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
} as const;

/** What a read runs under: the request's budget, its call (the deadline and the session's end) and the pin. */
export interface S3AgentReadContext {
  readonly budget: ReadOnlyStatementBudget;
  readonly call: S3CallOptions;
  readonly pinnedBucket?: string;
}

/**
 * A server's answer that a named bucket or key is missing or not readable. A server may refuse a bucket the key is
 * granted nothing on with 403 and answer one that does not exist with 404, as Garage does, while MinIO's lineage
 * answers both 403 to a key its policy scopes; and a HEAD of a key cannot tell a missing bucket from a missing key.
 * The status alone decides, whatever the body holds: a body that is not S3's error XML, or one sent compressed, for
 * one of the two statuses would otherwise tell them apart.
 */
const isMissingOrRefused = (error: unknown): error is S3ServerError =>
  error instanceof S3ServerError && (error.status === 403 || error.status === 404);

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

/**
 * The answer of one admitted read, through the agent's client alone. A read that names a bucket or a key answers a
 * bucket or a key that is missing and one the key may not read in one sentence, `notFound`, whatever the server sent,
 * so no named read is an oracle for a bucket or an object past what the key's grants let it list: only an answer the
 * server gave the key is passed on.
 */
export async function runS3AgentRead(
  client: S3AgentClient,
  plan: S3AgentPlan,
  context: S3AgentReadContext,
): Promise<S3AgentAnswer> {
  if (plan.op === "list-buckets") return listBuckets(client, context);
  try {
    return await readNamed(client, plan, context);
  } catch (error) {
    if (isMissingOrRefused(error)) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.notFound, S3_TYPE);
    throw error;
  }
}

async function listBuckets(client: S3AgentClient, context: S3AgentReadContext): Promise<S3AgentAnswer> {
  if (context.pinnedBucket !== undefined)
    return { op: "list-buckets", buckets: [{ name: context.pinnedBucket }], pinned: true };
  const { buckets, withheld, invalidNames } = await readableBuckets(client, context.call);
  const allowed = context.budget.maxResultRows;
  if (buckets.length > allowed) throw new QueryError(rowBudgetSentence(buckets.length, allowed), S3_TYPE);
  return {
    op: "list-buckets",
    buckets,
    ...(invalidNames === 0 ? {} : { invalidNames }),
    ...(withheld === 0 ? {} : { withheld }),
  };
}

/** The buckets an agent-mode listing may name, and how many it counts without naming. */
export interface S3ReadableBuckets {
  readonly buckets: readonly S3AgentBucket[];
  /** Listed buckets the server did not show this key may read. */
  readonly withheld: number;
  /** Listed names holding "/", which no S3 bucket name holds. */
  readonly invalidNames: number;
}

/**
 * A HEAD's answer that leaves a bucket unnamed: a refusal or a missing bucket (403, 404), or a bucket in another region
 * than the one the connection signs for (a 301, which the transport refuses to follow). None of them shows a grant.
 */
const withholdsBucket = (error: unknown): boolean =>
  (error instanceof S3ServerError && (error.status === 403 || error.status === 404 || error.status === 301)) ||
  (error instanceof TransportError && error.kind === "redirect");

/**
 * The buckets the signing key may read, checked by the server: one ListBuckets, then one HeadBucket per listed bucket
 * with the same key, at most `S3_AGENT_BUCKET_CHECK_CONCURRENCY` at once. A listing answers every bucket name to a key
 * holding s3:ListAllMyBuckets on Silo and RustFS, the buckets it is granted nothing on included, while a HEAD is
 * answered only where the key's grants allow the bucket (docs/providers/s3.md, "What a key's grants reach"), so only a
 * bucket whose HEAD succeeds is named, and the rest are counted. A key that lists more than `S3_AGENT_BUCKET_CHECK_MAX`
 * buckets is refused before any HEAD is sent, and a HEAD answered any other way refuses the listing, the HEADs still
 * waiting unsent.
 */
export async function readableBuckets(client: S3AgentClient, call: S3CallOptions): Promise<S3ReadableBuckets> {
  const listing = await client.listBuckets(call);
  if (listing.truncated) throw new QueryError(S3_AGENT_FAILURE_SENTENCES.bucketsCut, S3_TYPE);
  const listed = listing.buckets;
  if (listed.length > S3_AGENT_BUCKET_CHECK_MAX)
    throw new QueryError(S3_AGENT_FAILURE_SENTENCES.bucketChecksOver(listed.length), S3_TYPE);
  const readable: boolean[] = listed.map(() => false);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < listed.length) {
      const index = next;
      next += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker sends one HEAD at a time, so the checks stay bounded.
        await client.headBucket(listed[index].name, call);
        readable[index] = true;
      } catch (error) {
        if (!withholdsBucket(error)) {
          failed = true;
          throw error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(S3_AGENT_BUCKET_CHECK_CONCURRENCY, listed.length) }, worker));
  const buckets = listed.filter((_, index) => readable[index]);
  return { buckets, withheld: listed.length - buckets.length, invalidNames: listing.invalidNames.length };
}

/** One read that names a bucket, and for head-object a key. */
async function readNamed(
  client: S3AgentClient,
  plan: Exclude<S3AgentPlan, { op: "list-buckets" }>,
  context: S3AgentReadContext,
): Promise<S3AgentAnswer> {
  const { call } = context;
  switch (plan.op) {
    case "head-bucket": {
      const head = await client.headBucket(plan.bucket, call);
      return { op: "head-bucket", bucket: plan.bucket, exists: true, region: head.bucketRegion };
    }
    case "get-bucket-location":
      return { op: plan.op, bucket: plan.bucket, location: await client.getBucketLocation(plan.bucket, call) };
    case "get-bucket-versioning":
      return { op: plan.op, bucket: plan.bucket, state: await client.getBucketVersioning(plan.bucket, call) };
    case "summary":
      return summarize(client, plan.bucket, context);
    case "head-object":
      return { op: "head-object", bucket: plan.bucket, head: await client.headObject(plan.bucket, plan.key, call) };
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
      if (answer.withheld !== undefined)
        warnings.push({ message: S3_AGENT_FAILURE_SENTENCES.withheldBuckets(answer.withheld) });
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
      return { projected: projectMetadata(HEAD_OBJECT, [answer]), warnings: [] };
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
