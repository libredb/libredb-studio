/**
 * The S3 object surface: the `bucket` kind the tree lists, and the `object` kind the Keys
 * panel enumerates, each with a Source tab. No container level and no `relation` kind, so no connect-time inventory
 * read. A pinned connection counts and lists its one bucket with no request.
 *
 * The bucket Source document is three parts, one read each, and a refused read is its own part beside the others.
 * The object Source document checks the address and the pin first, then reads the HEAD (with its follow-up rule),
 * the tags only when the HEAD counts some, and then the preview parts the provider supplies, after
 * the Metadata part. A refusal the user can act on becomes the part's sentence; a deadline, a cancel or a closed
 * connection fails the whole document.
 */
import { AuthenticationError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { applySourceBound } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import type { BucketListing, ObjectHead, S3CallOptions, S3Operation, S3Surface, VersioningState } from "./client";
import { s3EndpointText } from "./connection-options";
import { S3_TYPE } from "./constants";
import { S3ServerError } from "./errors";
import { bucketAddressRefusal, objectAddressRefusal, sourceAddressSentence, splitVirtualKey } from "./names";

export const S3_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "bucket",
    role: "config",
    label: "Bucket",
    labelPlural: "Buckets",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "object",
    role: "config",
    label: "Object",
    labelPlural: "Objects",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
  },
] as const);

export const S3_OBJECTS_LISTED_ELSEWHERE = "Objects are listed in the Keys panel and with aws s3 ls in the console.";

export const S3_BUCKETS_SAMPLED_FROM = "the first 10,000 buckets this key may list";

/** The preview parts of one object, after its HEAD: the provider wires the object preview here. */
export type S3PreviewParts = (input: {
  readonly head: ObjectHead;
  readonly bucket: string;
  readonly key: string;
  readonly limit: number | undefined;
  readonly call: S3CallOptions;
}) => Promise<readonly ObjectSourcePart[]>;

/** What the session keeps for the Source tab: the creation dates its tree read, and the preview. */
export interface S3SourceMemory {
  readonly created: Map<string, string>;
  readonly previewParts: S3PreviewParts;
}

/** A connection is one key space with no container level, so every object is addressed at the root. */
export function requireS3Root(container: readonly string[]): void {
  if (container.length !== 0)
    throw new QueryError(`An S3 connection has no container level; received ${JSON.stringify(container)}`, S3_TYPE);
}

function requireKind(kind: string): void {
  if (!S3_OBJECT_KINDS.some((spec) => spec.id === kind))
    throw new QueryError(`S3 declares no object kind "${kind}"`, S3_TYPE);
}

/** Both kinds are addressed by one segment: a bucket's name, or an object's virtual key `<bucket>/<key>`. */
function requirePath(path: readonly string[], kind: string): string {
  requireKind(kind);
  if (path.length !== 1)
    throw new QueryError(`An S3 "${kind}" path is [name], received ${JSON.stringify(path)}`, S3_TYPE);
  return path[0];
}

/** The sentence of a refusal a part shows; anything that is not a refusal fails the whole document. */
function refusedPart(surface: S3Surface, error: unknown, operation: S3Operation): string {
  const failure = surface.fail(error, operation);
  if (failure instanceof QueryError || failure instanceof AuthenticationError || failure instanceof DatabaseConfigError)
    return failure.message;
  throw failure;
}

/** A JSON part rendered by Studio, under the caller's bound. */
function renderedJson(id: string, label: string, value: unknown, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(value, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

async function bucketList(surface: S3Surface, call: S3CallOptions): Promise<BucketListing> {
  try {
    return await surface.client.listBuckets(call);
  } catch (error) {
    throw surface.fail(error, "ListBuckets");
  }
}

/** Pinned: 1 with no request. Unpinned: one ListBuckets; a sample when truncated; unavailable when refused. */
export async function countS3Objects(surface: S3Surface, call: S3CallOptions): Promise<Record<string, KindCount>> {
  if (surface.options.pinnedBucket !== undefined) return { bucket: { count: 1 } };
  try {
    const listing = await surface.client.listBuckets(call);
    const count = listing.buckets.length;
    return { bucket: listing.truncated ? { count, sampledFrom: S3_BUCKETS_SAMPLED_FROM } : { count } };
  } catch (error) {
    const failure = surface.fail(error, "ListBuckets");
    if (failure instanceof QueryError && error instanceof S3ServerError && error.status === 403)
      return { bucket: { unavailable: failure.message } };
    throw failure;
  }
}

/** One row per bucket; the object kind is refused by name, as it is listed in the Keys panel. */
export async function listS3Objects(
  surface: S3Surface,
  kind: string,
  call: S3CallOptions,
  created: Map<string, string>,
): Promise<DatabaseObject[]> {
  if (kind === "object") throw new QueryError(S3_OBJECTS_LISTED_ELSEWHERE, S3_TYPE);
  requireKind(kind);
  const pin = surface.options.pinnedBucket;
  if (pin !== undefined) return [{ path: [pin], name: pin, kind: "bucket" }];
  const listing = await bucketList(surface, call);
  return listing.buckets.map((bucket) => {
    if (bucket.created !== undefined) created.set(bucket.name, bucket.created);
    return {
      path: [bucket.name],
      name: bucket.name,
      kind: "bucket",
      ...(bucket.created === undefined ? {} : { status: `created ${bucket.created.slice(0, 10)}` }),
    };
  });
}

export function describeS3Object(path: readonly string[], kind: string): ObjectDetail {
  requirePath(path, kind);
  return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
}

export function describeS3Objects(kind: string): ObjectDetailBatch {
  requireKind(kind);
  return { details: [] };
}

async function bucketSource(
  surface: S3Surface,
  bucket: string,
  limit: number | undefined,
  call: S3CallOptions,
  memory: S3SourceMemory,
): Promise<ObjectSourceDocument> {
  if (bucketAddressRefusal(bucket) !== undefined)
    throw new QueryError(sourceAddressSentence("bucket-pattern", { bucket, key: "" }), S3_TYPE);
  const signing = surface.options.region;
  const bucketPart = renderedJson(
    "bucket",
    "Bucket",
    {
      bucket,
      endpoint: s3EndpointText(surface.options),
      signing_region: signing,
      pinned: surface.options.pinnedBucket === bucket,
      created: memory.created.get(bucket) ?? null,
    },
    limit,
  );
  let location: ObjectSourcePart;
  try {
    const reported = await surface.client.getBucketLocation(bucket, call);
    location = renderedJson(
      "location",
      "Location",
      {
        location: reported,
        signing_region: signing,
        note:
          reported === signing
            ? null
            : `Requests to this bucket are signed for ${signing}; the bucket reports ${reported}.`,
      },
      limit,
    );
  } catch (error) {
    location = { id: "location", label: "Location", unavailable: refusedPart(surface, error, "GetBucketLocation") };
  }
  let versioning: ObjectSourcePart;
  try {
    const state: VersioningState = await surface.client.getBucketVersioning(bucket, call);
    versioning = renderedJson(
      "versioning",
      "Versioning",
      { status: state.status ?? "never enabled", mfa_delete: state.mfaDelete },
      limit,
    );
  } catch (error) {
    versioning = {
      id: "versioning",
      label: "Versioning",
      unavailable: refusedPart(surface, error, "GetBucketVersioning"),
    };
  }
  return { path: [bucket], kind: "bucket", parts: [bucketPart, location, versioning] };
}

async function objectSource(
  surface: S3Surface,
  virtualKey: string,
  limit: number | undefined,
  call: S3CallOptions,
  memory: S3SourceMemory,
): Promise<ObjectSourceDocument> {
  const { bucket, key } = splitVirtualKey(virtualKey);
  const verdict = objectAddressRefusal(bucket, key);
  if (verdict !== undefined) throw new QueryError(sourceAddressSentence(verdict, { bucket, key }), S3_TYPE);
  const pin = surface.options.pinnedBucket;
  if (pin !== undefined && bucket !== pin)
    throw new QueryError(sourceAddressSentence("outside-pin", { bucket, key, pin }), S3_TYPE);
  let head: ObjectHead;
  try {
    head = await surface.client.headObject(bucket, key, call);
  } catch (error) {
    return {
      path: [virtualKey],
      kind: "object",
      parts: [{ id: "metadata", label: "Metadata", unavailable: refusedPart(surface, error, "HeadObject") }],
    };
  }
  let tags: Record<string, string> | null = head.taggingCount === 0 ? {} : null;
  let tagsUnavailable: string | undefined;
  if (head.taggingCount !== null && head.taggingCount > 0) {
    try {
      tags = Object.fromEntries(
        (await surface.client.getObjectTagging(bucket, key, call)).map((tag) => [tag.key, tag.value]),
      );
    } catch (error) {
      tagsUnavailable = refusedPart(surface, error, "GetObjectTagging");
    }
  }
  const metadata = renderedJson(
    "metadata",
    "Metadata",
    {
      bucket,
      key,
      size_bytes: head.size,
      etag: head.etag,
      multipart_parts: head.partsFromEtag,
      last_modified: head.lastModified,
      content_type: head.contentType,
      content_encoding: head.contentEncoding,
      storage_class: head.storageClass,
      version_id: head.versionId,
      server_side_encryption: head.serverSideEncryption,
      restore: head.restore,
      archive_status: head.archiveStatus,
      tags,
      ...(tagsUnavailable === undefined ? {} : { tags_unavailable: tagsUnavailable }),
      user_metadata: head.userMetadata,
      missing_user_metadata: head.missingMetadata,
      metadata_cut: head.headersCut,
    },
    limit,
  );
  const previewParts = await memory.previewParts({ head, bucket, key, limit, call });
  return { path: [virtualKey], kind: "object", parts: [metadata, ...previewParts] };
}

export async function readS3ObjectSource(
  surface: S3Surface,
  path: readonly string[],
  kind: string,
  limit: number | undefined,
  call: S3CallOptions,
  memory: S3SourceMemory,
): Promise<ObjectSourceDocument> {
  const name = requirePath(path, kind);
  return kind === "bucket"
    ? bucketSource(surface, name, limit, call, memory)
    : objectSource(surface, name, limit, call, memory);
}
