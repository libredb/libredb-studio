/**
 * The S3 operation client: one function per read operation over PR 1's byte transport, every
 * one a GET or HEAD, and the limited client that takes one limiter permit per operation.
 *
 * This file holds the value types the console and the preview call with; the functions
 * follow them.
 */
import type { NodeByteResponse, NodeByteTransport } from "@/lib/db/http/node-transport";
import type { LimiterTicket, ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import type { S3ConnectionOptions } from "./connection-options";
import {
  S3_BUCKET_LIST_RESPONSE_BYTES,
  S3_CURSOR_TOKEN_MAX_CHARS,
  S3_HEAD_RESPONSE_BYTES,
  S3_KEY_SCAN_MAX_COUNT,
  S3_LIST_RESPONSE_BYTES,
  S3_MAX_BUCKETS_READ,
  S3_REGION_PATTERN,
  S3_SMALL_RESPONSE_BYTES,
} from "./constants";
import { objectPath, s3Query } from "./encoding";
import {
  fieldsOf,
  noteRequestNames,
  type S3AnswerProblem,
  S3ServerError,
  type S3RequestNames,
  type S3ServerErrorFields,
} from "./errors";
import { firstHeader, headerCount, readObjectHead } from "./headers";
import { shownName } from "./names";
import {
  type RawBucketList,
  readBucketList,
  readErrorDocument,
  readLocation,
  readObjectListing,
  readTagging,
  readVersioning,
  readVersionListing,
  unquotedEtag,
} from "./shapes";
import { readXml, type XmlElement } from "./xml";

export interface S3CallOptions {
  readonly signal: AbortSignal;
  /** Epoch ms; the call's AbortSignal already carries it, it is kept for sentences. */
  readonly deadline: number;
}

export interface S3Client {
  listBuckets(call: S3CallOptions): Promise<BucketListing>;
  headBucket(bucket: string, call: S3CallOptions): Promise<BucketHead>;
  getBucketLocation(bucket: string, call: S3CallOptions): Promise<string>;
  getBucketVersioning(bucket: string, call: S3CallOptions): Promise<VersioningState>;
  listObjectsV2(request: ListObjectsRequest, call: S3CallOptions): Promise<ObjectListing>;
  listObjectVersions(request: ListVersionsRequest, call: S3CallOptions): Promise<VersionListing>;
  headObject(bucket: string, key: string, call: S3CallOptions): Promise<ObjectHead>;
  getObjectRange(request: GetRangeRequest, call: S3CallOptions): Promise<ObjectBytes>;
  getObjectTagging(bucket: string, key: string, call: S3CallOptions): Promise<readonly ObjectTag[]>;
  close(): void;
}

export interface ListObjectsRequest {
  readonly bucket: string;
  readonly prefix: string;
  /** Present: one level ("/" only). Absent: a recursive walk. */
  readonly delimiter?: "/";
  /** 1 to S3_KEY_SCAN_MAX_COUNT. */
  readonly maxKeys: number;
  readonly continuationToken?: string;
}

export interface ObjectListing {
  readonly keys: readonly ListedObject[];
  readonly prefixes: readonly string[];
  /** Names on this page that are not text and so cannot be listed. */
  readonly undecodable: number;
  readonly isTruncated: boolean;
  readonly nextToken?: string;
}

export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified?: string;
  /** Quotes removed by the same rule as ObjectHead.etag. */
  readonly etag?: string;
  readonly storageClass?: string;
}

export interface GetRangeRequest {
  readonly bucket: string;
  readonly key: string;
  /** Sent as "Range: bytes=<first>-<last>" or "bytes=-<suffix>"; one range only. */
  readonly range?: { readonly first: number; readonly last?: number } | { readonly suffix: number };
  readonly maxBytes: number;
  readonly truncateAt?: number;
}

export interface ObjectBytes {
  readonly status: 200 | 206 | 416;
  readonly bytes: Buffer;
  readonly truncated: boolean;
  readonly contentRange: string | null;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  /** The answer's `etag` header, quotes removed by the same rule as ObjectHead.etag; null when absent. */
  readonly etag: string | null;
  /** The answer's `content-length` header as a non-negative safe integer, else null. */
  readonly contentLength: number | null;
}

export interface BucketListing {
  readonly buckets: readonly {
    readonly name: string /** ISO 8601 when CreationDate parses. */;
    readonly created?: string;
  }[];
  /** Names holding "/" or not UTF-8 text: counted, never listed. */
  readonly invalidNames: number;
  /** A ContinuationToken was in the answer and was not followed. */
  readonly truncated: boolean;
}

export interface BucketHead {
  readonly bucketRegion: string | null;
}

export interface VersioningState {
  /** null: never enabled. */
  readonly status: "Enabled" | "Suspended" | null;
  readonly mfaDelete: string | null;
}

export interface ListVersionsRequest {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter?: "/";
  /** 1 to S3_KEY_SCAN_MAX_COUNT. */
  readonly maxKeys: number;
}

export interface VersionEntry {
  readonly key: string;
  readonly versionId: string | null;
  readonly isLatest: boolean;
  readonly deleteMarker: boolean;
  readonly size: number | null;
  readonly lastModified?: string;
  readonly etag?: string;
}

export interface VersionListing {
  readonly entries: readonly VersionEntry[];
  readonly prefixes: readonly string[];
  readonly undecodable: number;
  readonly isTruncated: boolean;
}

export interface ObjectTag {
  readonly key: string;
  readonly value: string;
}

/** One field per response header a HEAD answer is read for, and nothing else. */
export interface ObjectHead {
  readonly size: number | null;
  readonly etag: string | null;
  readonly partsFromEtag: number | null;
  readonly lastModified: string | null;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly storageClass: string | null;
  readonly versionId: string | null;
  readonly deleteMarker: boolean;
  readonly taggingCount: number | null;
  readonly serverSideEncryption: string | null;
  readonly restore: string | null;
  readonly archiveStatus: string | null;
  readonly userMetadata: Readonly<Record<string, readonly string[]>>;
  readonly missingMetadata: number | null;
  readonly headersCut: boolean;
}

export interface S3ClientContext {
  /** The signing region, ${C} in the sentences. */
  readonly region: string;
  readonly signs: boolean;
  readonly clock: () => Date;
  /** S3ConnectionOptions.secretForms, for serverText. */
  readonly secretForms: readonly string[];
  /** "scheme://host:port" of the configured endpoint, an IPv6 host bracketed: ${endpoint} in the sentences. */
  readonly endpointText: string;
}

/** The operation names, one per GET or HEAD the client sends; every failure names one. */
export type S3Operation =
  | "ListBuckets"
  | "HeadBucket"
  | "GetBucketLocation"
  | "GetBucketVersioning"
  | "ListObjectsV2"
  | "ListObjectVersions"
  | "HeadObject"
  | "GetObject"
  | "GetObjectTagging";

/** What the provider hands the console part and the preview part: one session's limited client and its failure path. */
export interface S3Surface {
  /** The limited client. */
  readonly client: S3Client;
  readonly options: S3ConnectionOptions;
  /** Wraps any failure of this session with toProviderError, naming one operation of the verb table. */
  fail(error: unknown, operation: S3Operation): unknown;
}

/** One request as the client builds it, with the names a failure is worded with. */
interface Sent {
  readonly operation: S3Operation;
  readonly method: "GET" | "HEAD";
  readonly path: string;
  readonly query: string;
  readonly capBytes: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly truncateAt?: number;
  readonly bucket?: string;
  readonly key?: string;
  readonly prefix?: string;
  readonly sentToken?: boolean;
}

const FIRST_KEY_QUERY = s3Query([
  ["encoding-type", "url"],
  ["list-type", "2"],
  ["max-keys", "1"],
  ["prefix", ""],
]);

function namesOf(sent: Pick<Sent, "bucket" | "key" | "prefix" | "capBytes">): S3RequestNames {
  return {
    ...(sent.bucket === undefined ? {} : { bucket: sent.bucket }),
    ...(sent.key === undefined ? {} : { key: sent.key }),
    ...(sent.prefix === undefined ? {} : { prefix: sent.prefix }),
    capBytes: sent.capBytes,
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isCompressed(response: NodeByteResponse): boolean {
  return response.contentEncoding !== null && response.contentEncoding.toLowerCase() !== "identity";
}

async function send(transport: NodeByteTransport, sent: Sent, call: S3CallOptions): Promise<NodeByteResponse> {
  try {
    return await transport.request({
      method: sent.method,
      target: { path: sent.path, query: sent.query },
      signal: call.signal,
      maxResponseBytes: sent.capBytes,
      ...(sent.headers === undefined ? {} : { headers: sent.headers }),
      ...(sent.truncateAt === undefined ? {} : { truncateAt: sent.truncateAt }),
    });
  } catch (error) {
    noteRequestNames(error, namesOf(sent));
    throw error;
  }
}

/** The fields every failure of an answer carries: the request's names and the answer's headers. */
function answerFields(sent: Sent, response: NodeByteResponse): S3ServerErrorFields {
  const header = (name: string) => firstHeader(response.headers, name);
  const bucketRegion = header("x-amz-bucket-region");
  const serverDate = header("date");
  const requestId = header("x-amz-request-id") ?? header("x-request-id");
  return {
    operation: sent.operation,
    method: sent.method,
    status: response.status,
    ...(sent.bucket === undefined ? {} : { bucket: sent.bucket }),
    ...(sent.key === undefined ? {} : { key: sent.key }),
    ...(sent.prefix === undefined ? {} : { prefix: sent.prefix }),
    ...(sent.sentToken === true ? { sentToken: true } : {}),
    ...(bucketRegion === undefined ? {} : { bucketRegion }),
    ...(serverDate === undefined ? {} : { serverDate }),
    ...(header("x-amz-delete-marker") === "true" ? { deleteMarker: true } : {}),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function answerProblem(sent: Sent, response: NodeByteResponse, problem: S3AnswerProblem): S3ServerError {
  return new S3ServerError({ ...answerFields(sent, response), problem });
}

/** An error status: its code from the XML body, else from x-minio-error-code (a HEAD has no body). */
function errorOf(sent: Sent, response: NodeByteResponse, xmlOperation: boolean): S3ServerError {
  const fields = answerFields(sent, response);
  if (xmlOperation && isCompressed(response))
    return new S3ServerError({
      ...fields,
      problem: { kind: "compressed", contentEncoding: response.contentEncoding as string },
    });
  if (response.bytes.length === 0) {
    const code = firstHeader(response.headers, "x-minio-error-code");
    return new S3ServerError(code === undefined ? fields : { ...fields, code });
  }
  const read = readXml(response.bytes);
  const document = read.ok ? readErrorDocument(read.root) : undefined;
  if (document === undefined)
    return new S3ServerError({
      ...fields,
      problem: read.ok ? { kind: "not-s3" } : { kind: "not-s3", xml: read.reason },
    });
  return new S3ServerError({ ...fields, ...document });
}

/** A 2xx XML answer's root; refused before any XML is read when it is compressed (row E7b). */
async function xmlRoot(
  transport: NodeByteTransport,
  sent: Sent,
  call: S3CallOptions,
): Promise<{ readonly root: XmlElement; readonly response: NodeByteResponse }> {
  const response = await send(transport, sent, call);
  if (!isSuccess(response.status)) throw errorOf(sent, response, true);
  if (isCompressed(response))
    throw answerProblem(sent, response, { kind: "compressed", contentEncoding: response.contentEncoding as string });
  const read = readXml(response.bytes);
  if (!read.ok) throw answerProblem(sent, response, { kind: "not-s3", xml: read.reason });
  return { root: read.root, response };
}

async function shaped<T>(
  transport: NodeByteTransport,
  sent: Sent,
  call: S3CallOptions,
  reader: (root: XmlElement) => T | undefined,
): Promise<T> {
  const { root, response } = await xmlRoot(transport, sent, call);
  const value = reader(root);
  if (value === undefined) throw answerProblem(sent, response, { kind: "not-s3" });
  return value;
}

/**
 * A HEAD; when it fails with no code (RustFS and Garage always, Silo on skew), exactly one follow-up GET reads an
 * error code, in the same permit because the limited client wraps this whole function. A 2xx
 * follow-up, or one with no code, leaves the HEAD's status to be classified; the HEAD is never sent again.
 * The object follow-up carries truncateAt at its own cap, S3_SMALL_RESPONSE_BYTES: the transport cuts every
 * status at truncateAt, so an error body of up to that cap is read whole, and a server that ignores Range and
 * answers 200 with the whole object resolves as cut data, never as too-large.
 */
async function headWithFollowUp(
  transport: NodeByteTransport,
  sent: Sent,
  followUp: Sent,
  call: S3CallOptions,
): Promise<NodeByteResponse> {
  const response = await send(transport, sent, call);
  if (isSuccess(response.status)) return response;
  const failure = errorOf(sent, response, false);
  if (failure.code !== undefined) throw failure;
  let answer: NodeByteResponse;
  try {
    answer = await send(transport, followUp, call);
  } catch (error) {
    if (call.signal.aborted) throw error;
    throw failure;
  }
  if (isSuccess(answer.status)) throw failure;
  const followed = errorOf(followUp, answer, false);
  if (followed.code === undefined) throw failure;
  const fields = fieldsOf(failure);
  throw new S3ServerError({
    ...fields,
    status: followed.status,
    code: followed.code,
    ...(followed.serverMessage === undefined ? {} : { message: followed.serverMessage }),
    ...(followed.region === undefined ? {} : { region: followed.region }),
    ...(fields.bucketRegion === undefined && followed.bucketRegion !== undefined
      ? { bucketRegion: followed.bucketRegion }
      : {}),
    ...(followed.serverDate === undefined ? {} : { serverDate: followed.serverDate }),
  });
}

function checkMaxKeys(maxKeys: number): void {
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > S3_KEY_SCAN_MAX_COUNT)
    throw new Error(`maxKeys must be a whole number from 1 to ${S3_KEY_SCAN_MAX_COUNT}`);
}

/** The client's own page checks, before the Keys panel route sees the page; the defect in words, or undefined. */
function pageDefect(listing: ObjectListing, maxKeys: number): string | undefined {
  const entries = listing.keys.length + listing.prefixes.length + listing.undecodable;
  if (entries > maxKeys)
    return `${entries.toLocaleString("en-US")} entries for a page of at most ${maxKeys.toLocaleString("en-US")}`;
  const seen = new Set<string>();
  for (const prefix of listing.prefixes) {
    if (seen.has(prefix)) return `the folder ${shownName(prefix)} twice`;
    seen.add(prefix);
  }
  if (listing.isTruncated && listing.nextToken === undefined) return "a truncated page and no continuation token";
  return undefined;
}

/** De-duplicated by exact name, sorted by UTF-8 byte order; a name holding "/" is counted, never listed. */
function bucketListing(raw: RawBucketList): BucketListing {
  const seen = new Set<string>();
  const buckets: { name: string; created?: string }[] = [];
  let invalidNames = 0;
  for (const bucket of raw.buckets) {
    if (bucket.name.includes("/")) {
      invalidNames += 1;
      continue;
    }
    if (seen.has(bucket.name)) continue;
    seen.add(bucket.name);
    buckets.push(bucket);
  }
  buckets.sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
  return { buckets, invalidNames, truncated: raw.truncated };
}

function rangeHeader(range: NonNullable<GetRangeRequest["range"]>): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  return range.last === undefined ? `bytes=${range.first}-` : `bytes=${range.first}-${range.last}`;
}

/** One function per read operation over PR 1's byte transport; every request is a GET or HEAD. */
export function createS3Client(transport: NodeByteTransport): S3Client {
  return {
    async listBuckets(call) {
      const sent: Sent = {
        operation: "ListBuckets",
        method: "GET",
        path: "/",
        query: s3Query([["max-buckets", String(S3_MAX_BUCKETS_READ)]]),
        capBytes: S3_BUCKET_LIST_RESPONSE_BYTES,
      };
      return bucketListing(await shaped(transport, sent, call, readBucketList));
    },

    async headBucket(bucket, call) {
      const path = objectPath(bucket);
      const names = { bucket };
      const response = await headWithFollowUp(
        transport,
        { operation: "HeadBucket", method: "HEAD", path, query: "", capBytes: S3_HEAD_RESPONSE_BYTES, ...names },
        {
          operation: "HeadBucket",
          method: "GET",
          path,
          query: FIRST_KEY_QUERY,
          capBytes: S3_SMALL_RESPONSE_BYTES,
          ...names,
        },
        call,
      );
      const region = firstHeader(response.headers, "x-amz-bucket-region");
      return { bucketRegion: region !== undefined && S3_REGION_PATTERN.test(region) ? region : null };
    },

    getBucketLocation(bucket, call) {
      const sent: Sent = {
        operation: "GetBucketLocation",
        method: "GET",
        path: objectPath(bucket),
        query: s3Query([["location", ""]]),
        capBytes: S3_SMALL_RESPONSE_BYTES,
        bucket,
      };
      return shaped(transport, sent, call, readLocation);
    },

    getBucketVersioning(bucket, call) {
      const sent: Sent = {
        operation: "GetBucketVersioning",
        method: "GET",
        path: objectPath(bucket),
        query: s3Query([["versioning", ""]]),
        capBytes: S3_SMALL_RESPONSE_BYTES,
        bucket,
      };
      return shaped(transport, sent, call, readVersioning);
    },

    async listObjectsV2(request, call) {
      checkMaxKeys(request.maxKeys);
      const token = request.continuationToken;
      const sent: Sent = {
        operation: "ListObjectsV2",
        method: "GET",
        path: objectPath(request.bucket),
        query: s3Query([
          ["encoding-type", "url"],
          ["list-type", "2"],
          ["max-keys", String(request.maxKeys)],
          ["prefix", request.prefix],
          ...(request.delimiter === undefined ? [] : ([["delimiter", "/"]] as const)),
          ...(token === undefined ? [] : ([["continuation-token", token]] as const)),
        ]),
        capBytes: S3_LIST_RESPONSE_BYTES,
        bucket: request.bucket,
        prefix: request.prefix,
        sentToken: token !== undefined,
      };
      const { root, response } = await xmlRoot(transport, sent, call);
      const listing = readObjectListing(root);
      if (listing === undefined) throw answerProblem(sent, response, { kind: "not-s3" });
      const defect = pageDefect(listing, request.maxKeys);
      if (defect !== undefined) throw answerProblem(sent, response, { kind: "page", what: defect });
      if (listing.nextToken !== undefined && listing.nextToken.length > S3_CURSOR_TOKEN_MAX_CHARS)
        throw answerProblem(sent, response, { kind: "token" });
      return listing;
    },

    listObjectVersions(request, call) {
      checkMaxKeys(request.maxKeys);
      const sent: Sent = {
        operation: "ListObjectVersions",
        method: "GET",
        path: objectPath(request.bucket),
        query: s3Query([
          ["encoding-type", "url"],
          ["max-keys", String(request.maxKeys)],
          ["prefix", request.prefix],
          ["versions", ""],
          ...(request.delimiter === undefined ? [] : ([["delimiter", "/"]] as const)),
        ]),
        capBytes: S3_LIST_RESPONSE_BYTES,
        bucket: request.bucket,
        prefix: request.prefix,
      };
      return shaped(transport, sent, call, readVersionListing);
    },

    async headObject(bucket, key, call) {
      const path = objectPath(bucket, key);
      const response = await headWithFollowUp(
        transport,
        { operation: "HeadObject", method: "HEAD", path, query: "", capBytes: S3_HEAD_RESPONSE_BYTES, bucket, key },
        {
          operation: "HeadObject",
          method: "GET",
          path,
          query: "",
          capBytes: S3_SMALL_RESPONSE_BYTES,
          truncateAt: S3_SMALL_RESPONSE_BYTES,
          headers: { range: "bytes=0-0" },
          bucket,
          key,
        },
        call,
      );
      return readObjectHead(response);
    },

    async getObjectRange(request, call) {
      const sent: Sent = {
        operation: "GetObject",
        method: "GET",
        path: objectPath(request.bucket, request.key),
        query: "",
        capBytes: request.maxBytes,
        ...(request.truncateAt === undefined ? {} : { truncateAt: request.truncateAt }),
        ...(request.range === undefined ? {} : { headers: { range: rangeHeader(request.range) } }),
        bucket: request.bucket,
        key: request.key,
      };
      const response = await send(transport, sent, call);
      const { status } = response;
      if (status !== 200 && status !== 206 && status !== 416) throw errorOf(sent, response, false);
      const etag = firstHeader(response.headers, "etag");
      return {
        status,
        bytes: status === 416 ? Buffer.alloc(0) : response.bytes,
        truncated: response.truncated,
        contentRange: firstHeader(response.headers, "content-range") ?? null,
        contentType: response.contentType,
        contentEncoding: response.contentEncoding,
        etag: etag === undefined ? null : unquotedEtag(etag),
        contentLength: headerCount(firstHeader(response.headers, "content-length")),
      };
    },

    getObjectTagging(bucket, key, call) {
      const sent: Sent = {
        operation: "GetObjectTagging",
        method: "GET",
        path: objectPath(bucket, key),
        query: s3Query([["tagging", ""]]),
        capBytes: S3_SMALL_RESPONSE_BYTES,
        bucket,
        key,
      };
      return shaped(transport, sent, call, readTagging);
    },

    close() {
      transport.close();
    },
  };
}

/** One permit per operation; a permit-wait failure carries the operation's names, as a request failure does. */
async function withPermit<T>(
  limiter: ProviderLimiter,
  names: S3RequestNames,
  call: S3CallOptions,
  run: () => Promise<T>,
): Promise<T> {
  let ticket: LimiterTicket;
  try {
    ticket = await limiter.acquire(call.signal);
  } catch (error) {
    noteRequestNames(error, names);
    throw error;
  }
  try {
    return await run();
  } finally {
    ticket.release();
  }
}

/**
 * The client every module reads through: one limiter permit per client operation. The call's
 * signal already carries its deadline, so the permit wait counts inside it; an operation's follow-up GET runs inside
 * the same permit, so no wait is nested.
 */
export function limitedS3Client(client: S3Client, limiter: ProviderLimiter): S3Client {
  const small = S3_SMALL_RESPONSE_BYTES;
  return {
    listBuckets: (call) =>
      withPermit(limiter, { capBytes: S3_BUCKET_LIST_RESPONSE_BYTES }, call, () => client.listBuckets(call)),
    headBucket: (bucket, call) =>
      withPermit(limiter, { bucket, capBytes: S3_HEAD_RESPONSE_BYTES }, call, () => client.headBucket(bucket, call)),
    getBucketLocation: (bucket, call) =>
      withPermit(limiter, { bucket, capBytes: small }, call, () => client.getBucketLocation(bucket, call)),
    getBucketVersioning: (bucket, call) =>
      withPermit(limiter, { bucket, capBytes: small }, call, () => client.getBucketVersioning(bucket, call)),
    listObjectsV2: (request, call) =>
      withPermit(
        limiter,
        { bucket: request.bucket, prefix: request.prefix, capBytes: S3_LIST_RESPONSE_BYTES },
        call,
        () => client.listObjectsV2(request, call),
      ),
    listObjectVersions: (request, call) =>
      withPermit(
        limiter,
        { bucket: request.bucket, prefix: request.prefix, capBytes: S3_LIST_RESPONSE_BYTES },
        call,
        () => client.listObjectVersions(request, call),
      ),
    headObject: (bucket, key, call) =>
      withPermit(limiter, { bucket, key, capBytes: S3_HEAD_RESPONSE_BYTES }, call, () =>
        client.headObject(bucket, key, call),
      ),
    getObjectRange: (request, call) =>
      withPermit(limiter, { bucket: request.bucket, key: request.key, capBytes: request.maxBytes }, call, () =>
        client.getObjectRange(request, call),
      ),
    getObjectTagging: (bucket, key, call) =>
      withPermit(limiter, { bucket, key, capBytes: small }, call, () => client.getObjectTagging(bucket, key, call)),
    close: () => client.close(),
  };
}
