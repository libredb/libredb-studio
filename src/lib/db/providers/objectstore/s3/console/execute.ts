/**
 * Running an accepted S3 console command over the core's client.
 *
 * Server only. It calls only the `S3Client` methods the core defines and adds no request field: ListObjectsV2 reads on
 * page by page, asking each page for exactly the rows still wanted, so it never cuts inside a page and its next token
 * is the service's own; ListBuckets and ListObjectVersions are one request each; every other read is one request;
 * `preview` is a HEAD, then the preview engine over the core's adapter. Every request runs under the run's one call
 * (its signal and deadline), and every failure of the client passes through `surface.fail` with its operation, so
 * every error sentence is the core's.
 */
import { QueryError } from "@/lib/db/errors";
import type { S3CallOptions, S3Operation } from "../client";
import { S3_TYPE } from "../constants";
import type { S3Surface } from "../index";
import { previewObject } from "../preview";
import { rangeReader, toPreviewHead } from "../preview-adapter";
import type { ParsedS3Command, S3ConsoleCommand } from "./commands";
import { S3_MAX_PAGES_PER_RUN } from "./constants";
import type { S3ListedEntry, S3Outcome, S3RunStop } from "./results";

export const S3_REPEATED_TOKEN_SENTENCE =
  "The server sent the same next token twice, so reading on would repeat a page: Studio stopped. Report this to the server's maintainers.";

/** The preview's seams, replaceable in tests; the defaults are the core's adapter and the preview engine. */
export interface S3ExecuteDeps {
  readonly previewObject: typeof previewObject;
  readonly toPreviewHead: typeof toPreviewHead;
  readonly rangeReader: typeof rangeReader;
}

const DEFAULT_DEPS: S3ExecuteDeps = { previewObject, toPreviewHead, rangeReader };

export interface S3RunContext {
  /** The run's signal (cancel and session end) and its one deadline, the connection's query timeout. */
  readonly call: S3CallOptions;
  /** The connection's Bucket field: bucket listings answer it with no request. */
  readonly pinnedBucket?: string;
}

/** One client operation: nothing is sent once the run is cancelled, and any failure is the surface's. */
async function send<T>(
  surface: S3Surface,
  operation: S3Operation,
  call: S3CallOptions,
  request: () => Promise<T>,
): Promise<T> {
  try {
    call.signal.throwIfAborted();
    return await request();
  } catch (error) {
    throw surface.fail(error, operation);
  }
}

async function listBuckets(
  surface: S3Surface,
  prefix: string | undefined,
  maxItems: number,
  context: S3RunContext,
): Promise<S3Outcome> {
  const wanted = prefix ?? "";
  if (context.pinnedBucket !== undefined) {
    const buckets = context.pinnedBucket.startsWith(wanted) ? [{ name: context.pinnedBucket }] : [];
    return { kind: "buckets", buckets, cut: false, truncated: false, invalidNames: 0, pinned: context.pinnedBucket };
  }
  const listing = await send(surface, "ListBuckets", context.call, () => surface.client.listBuckets(context.call));
  const matching = listing.buckets.filter((bucket) => bucket.name.startsWith(wanted));
  return {
    kind: "buckets",
    buckets: matching.slice(0, maxItems),
    cut: matching.length > maxItems,
    truncated: listing.truncated,
    invalidNames: listing.invalidNames.filter((name) => name.startsWith(wanted)).length,
  };
}

interface ObjectRun {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter: boolean;
  readonly maxItems: number;
  readonly pageSize: number;
  readonly resume?: { readonly continuationToken: string; readonly truncateAmount?: number };
}

/**
 * A ListObjectsV2 run: each page asks for min(page size, rows still wanted), plus the truncate amount on
 * a CLI token's first page, whose first N objects and every folder are dropped, as the AWS CLI resumes. It stops at
 * the rows wanted, at the server's last page or after the page cap; a next token already used, the starting token
 * included, fails it.
 */
async function listObjects(surface: S3Surface, run: ObjectRun, context: S3RunContext): Promise<S3Outcome> {
  const entries: S3ListedEntry[] = [];
  const used = new Set<string>();
  let token = run.resume?.continuationToken;
  if (token !== undefined) used.add(token);
  let skip = run.resume?.truncateAmount ?? 0;
  let requests = 0;
  let undecodable = 0;
  let stop: S3RunStop = "complete";
  for (;;) {
    const maxKeys = Math.min(run.pageSize, run.maxItems - entries.length + skip);
    const request = {
      bucket: run.bucket,
      prefix: run.prefix,
      ...(run.delimiter ? { delimiter: "/" as const } : {}),
      maxKeys,
      ...(token === undefined ? {} : { continuationToken: token }),
    };
    const page = await send(surface, "ListObjectsV2", context.call, () =>
      surface.client.listObjectsV2(request, context.call),
    );
    requests += 1;
    undecodable += page.undecodable;
    if (skip > 0) {
      for (const object of page.keys.slice(skip)) entries.push({ kind: "object", object });
      skip = 0;
    } else {
      for (const prefix of page.prefixes) entries.push({ kind: "prefix", prefix });
      for (const object of page.keys) entries.push({ kind: "object", object });
    }
    if (!page.isTruncated) {
      token = undefined;
      break;
    }
    const next = page.nextToken as string;
    if (used.has(next)) throw new QueryError(S3_REPEATED_TOKEN_SENTENCE, S3_TYPE);
    used.add(next);
    token = next;
    if (entries.length >= run.maxItems) {
      stop = "rows";
      break;
    }
    if (requests >= S3_MAX_PAGES_PER_RUN) {
      stop = "page-cap";
      break;
    }
  }
  return {
    kind: "objects",
    entries,
    stop,
    ...(token === undefined ? {} : { nextToken: token }),
    requests,
    undecodable,
  };
}

/** One page of versions, no marker; an over-full page is cut client-side, folder rows first. */
async function listVersions(
  surface: S3Surface,
  command: Extract<S3ConsoleCommand, { kind: "list-object-versions" }>,
  context: S3RunContext,
): Promise<S3Outcome> {
  const request = {
    bucket: command.bucket,
    prefix: command.prefix,
    ...(command.delimiter ? { delimiter: "/" as const } : {}),
    maxKeys: command.maxItems,
  };
  const listing = await send(surface, "ListObjectVersions", context.call, () =>
    surface.client.listObjectVersions(request, context.call),
  );
  if (listing.prefixes.length + listing.entries.length <= command.maxItems)
    return { kind: "versions", listing, cut: false };
  const prefixes = listing.prefixes.slice(0, command.maxItems);
  const entries = listing.entries.slice(0, command.maxItems - prefixes.length);
  return { kind: "versions", listing: { ...listing, prefixes, entries }, cut: true };
}

async function preview(
  surface: S3Surface,
  command: Extract<S3ConsoleCommand, { kind: "preview" }>,
  context: S3RunContext,
  deps: S3ExecuteDeps,
): Promise<S3Outcome> {
  const { bucket, key } = command;
  const head = await send(surface, "HeadObject", context.call, () =>
    surface.client.headObject(bucket, key, context.call),
  );
  const previewHead = deps.toPreviewHead(head, bucket, key);
  if (typeof previewHead === "string") throw new QueryError(previewHead, S3_TYPE);
  try {
    const answer = await deps.previewObject({
      head: previewHead,
      reader: deps.rangeReader(surface.client, bucket, key, context.call),
      request: command.request,
      purpose: "console",
      signal: context.call.signal,
    });
    return { kind: "preview", preview: answer };
  } catch (error) {
    throw surface.fail(error, "GetObject");
  }
}

/** The typed answers of one accepted command. */
export async function executeS3Command(
  surface: S3Surface,
  parsed: ParsedS3Command,
  context: S3RunContext,
  deps: S3ExecuteDeps = DEFAULT_DEPS,
): Promise<S3Outcome> {
  const command = parsed.command;
  const { client } = surface;
  const { call } = context;
  switch (command.kind) {
    case "ls":
      return command.bucket === ""
        ? listBuckets(surface, command.bucketNamePrefix, command.maxItems, context)
        : listObjects(
            surface,
            {
              bucket: command.bucket,
              prefix: command.prefix,
              delimiter: !command.recursive,
              maxItems: command.maxItems,
              pageSize: command.pageSize,
            },
            context,
          );
    case "list-buckets":
      return listBuckets(surface, command.prefix, command.maxItems, context);
    case "list-objects-v2":
      return listObjects(surface, command, context);
    case "list-object-versions":
      return listVersions(surface, command, context);
    case "head-bucket":
      return {
        kind: "bucket-head",
        head: await send(surface, "HeadBucket", call, () => client.headBucket(command.bucket, call)),
      };
    case "head-object":
      return {
        kind: "object-head",
        head: await send(surface, "HeadObject", call, () => client.headObject(command.bucket, command.key, call)),
      };
    case "get-object-tagging":
      return {
        kind: "tags",
        tags: await send(surface, "GetObjectTagging", call, () =>
          client.getObjectTagging(command.bucket, command.key, call),
        ),
      };
    case "get-bucket-location":
      return {
        kind: "location",
        region: await send(surface, "GetBucketLocation", call, () => client.getBucketLocation(command.bucket, call)),
      };
    case "get-bucket-versioning":
      return {
        kind: "versioning",
        state: await send(surface, "GetBucketVersioning", call, () => client.getBucketVersioning(command.bucket, call)),
      };
    case "preview":
      return preview(surface, command, context, deps);
  }
}
