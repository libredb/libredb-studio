/**
 * The S3 operation client: one function per read operation over PR 1's byte transport, every
 * one a GET or HEAD, and the limited client that takes one limiter permit per operation.
 *
 * This file holds the value types the console and the preview call with; the functions
 * follow them.
 */
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
