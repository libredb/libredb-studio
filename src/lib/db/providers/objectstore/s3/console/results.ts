/**
 * Each S3 console command's grid and notices: the outcome `execute.ts` returns, as a
 * `QueryResult`. Every value comes from a field the core's typed answers carry.
 *
 * Server only by role (it is pure): `execute.ts` and the provider call it. Notices are `warnings`, absent when there
 * is none (`src/lib/types.ts`), those about the answer first and then the matched-options and no-op options notices,
 * which are about the command, as Oxia orders them. No notice names a tag set's version: the core's GetObjectTagging
 * returns no version id.
 *
 * Every text cell the server wrote goes through the cell bound, and a grid holds at most `S3_RESULT_MAX_ROWS` rows:
 * the run cuts the listings, and this module cuts the tags, whose count only the response size bounds, before any
 * row past the bound is built.
 */
import type { QueryResult, QueryWarning } from "@/lib/types";
import type { BucketHead, ListedObject, ObjectHead, ObjectTag, VersionListing, VersioningState } from "../client";
import type { S3Preview } from "../preview";
import { previewQueryResult } from "../preview-render";
import { joinWithAnd, type ParsedS3Command, type S3ConsoleCommand } from "./commands";
import { S3_CELL_CHARS, S3_RESULT_MAX_ROWS } from "./constants";
import { cliEtag, humanReadableSize, isoUtc, lsDate } from "./format";
import { s3ReadOnCommand } from "./generators";
import { encodeS3StartingToken } from "./token";

/** Why a ListObjectsV2 run stopped: the server's last page, the rows wanted, or the page cap. */
export type S3RunStop = "complete" | "rows" | "page-cap";

/** One row of an object listing: a folder (CommonPrefixes) or an object (Contents). */
export type S3ListedEntry =
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "object"; readonly object: ListedObject };

/** What a run returns: the core's typed answers, plus the run's page count and stop reason for a listing. */
export type S3Outcome =
  | {
      readonly kind: "buckets";
      readonly buckets: readonly { readonly name: string; readonly created?: string }[];
      /** More names matched than --max-items keeps. */
      readonly cut: boolean;
      /** The server sent a continuation token the core did not follow. */
      readonly truncated: boolean;
      readonly invalidNames: number;
      /** Set on a pinned connection, which sends no ListBuckets. */
      readonly pinned?: string;
    }
  | {
      readonly kind: "objects";
      readonly entries: readonly S3ListedEntry[];
      readonly stop: S3RunStop;
      /** The service's next token, present when the run stopped with more to read. */
      readonly nextToken?: string;
      readonly requests: number;
      readonly undecodable: number;
    }
  | { readonly kind: "versions"; readonly listing: VersionListing; readonly cut: boolean }
  | { readonly kind: "bucket-head"; readonly head: BucketHead }
  | { readonly kind: "object-head"; readonly head: ObjectHead }
  | { readonly kind: "tags"; readonly tags: readonly ObjectTag[] }
  | { readonly kind: "location"; readonly region: string }
  | { readonly kind: "versioning"; readonly state: VersioningState }
  | { readonly kind: "preview"; readonly preview: S3Preview };

/** The notices whose text is fixed, read back by the provider-doc test. */
export const S3_CONSOLE_NOTICES = Object.freeze({
  bucketsNotAllListed:
    "The server holds more buckets than it listed in one answer, and Studio does not ask for the rest in this version: put a bucket's name in the Bucket field of the connection to read it.",
  noMatch: "No key and no folder begins with this prefix.",
  bucketNoRegion: "The bucket exists and this connection may read it: the server sent no region for it.",
  versioningNever: "Versioning was never turned on for this bucket: S3 answers no Status.",
  noTags: "The object has no tags.",
  moreVersions: "The server holds more versions than this page shows: narrow --prefix to see the rest.",
  headersCut: "The server sent more headers than Studio reads, so some fields may be missing.",
  tagsCut: "The object has {total} tags, and the result holds the first {shown}, the most a Studio result holds.",
});

const count = (n: number): string => n.toLocaleString("en-US");

type Row = Record<string, unknown>;
type Notice = string | undefined;

interface CellBound {
  readonly text: (value: string) => string;
  /** An optional value, written by `write` when present (a date or an ETag), then bounded; null when absent. */
  readonly optional: (value: string | undefined | null, write?: (text: string) => string) => string | null;
  readonly notice: () => Notice;
}

/** Cells over the bound are cut on a character, never between a surrogate pair, and counted for one notice. */
function cellBound(): CellBound {
  let cut = 0;
  const text = (value: string): string => {
    if (value.length <= S3_CELL_CHARS) return value;
    cut += 1;
    const last = value.charCodeAt(S3_CELL_CHARS - 1);
    return value.slice(0, last >= 0xd800 && last <= 0xdbff ? S3_CELL_CHARS - 1 : S3_CELL_CHARS);
  };
  return {
    text,
    optional: (value, write = (same) => same) => (value === undefined || value === null ? null : text(write(value))),
    notice: () => (cut === 0 ? undefined : `${count(cut)} cell(s) were cut at ${count(S3_CELL_CHARS)} characters.`),
  };
}

/** The names the core counted and did not list. */
const undecodableNotice = (n: number): Notice =>
  n > 0
    ? `${count(n)} names on the pages read are not UTF-8 text or not a valid name, so Studio does not list them.`
    : undefined;

/** The matched-options notice: the connection-owned options that named the connection's own value. */
function matchedNotice(matched: ParsedS3Command["matched"]): Notice {
  if (matched.length === 0) return undefined;
  const one = matched.length === 1;
  const what = matched.map((option) => (option === "--endpoint-url" ? "endpoint" : "region"));
  return `${joinWithAnd(matched)} ${one ? "names" : "name"} this connection's own ${joinWithAnd(what)}, so ${one ? "it changes" : "they change"} nothing: the connection decides where Studio connects and which region signs.`;
}

/** The no-op options notice: the options that change only how the AWS CLI prints. */
function noOpNotice(noOps: readonly string[]): Notice {
  if (noOps.length === 0) return undefined;
  return `${joinWithAnd(noOps)} ${noOps.length === 1 ? "changes" : "change"} nothing in Studio: every result is a grid.`;
}

function grid(
  fields: string[],
  rows: Row[],
  notices: readonly Notice[],
  parsed: ParsedS3Command,
  executionTime: number,
  columnTypes?: Record<string, string>,
): QueryResult {
  const warnings: QueryWarning[] = [...notices, matchedNotice(parsed.matched), noOpNotice(parsed.noOps)]
    .filter((notice): notice is string => notice !== undefined)
    .map((message) => ({ message }));
  return {
    rows,
    fields,
    rowCount: rows.length,
    executionTime,
    ...(columnTypes === undefined ? {} : { columnTypes }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

type LsCommand = Extract<S3ConsoleCommand, { kind: "ls" }>;
type ObjectsOutcome = Extract<S3Outcome, { kind: "objects" }>;

/** The read-on notice: the first rows, why the run stopped, and how to read on. */
function readOnNotice(command: S3ConsoleCommand, outcome: ObjectsOutcome): Notice {
  if (outcome.stop === "complete" || outcome.nextToken === undefined) return undefined;
  const rows = count(outcome.entries.length);
  const reason =
    outcome.stop === "page-cap"
      ? `, after ${count(outcome.requests)} requests, the most one run sends`
      : command.kind === "list-objects-v2" && command.maxItemsGiven
        ? ""
        : ", the most a Studio result holds";
  const token = encodeS3StartingToken(outcome.nextToken);
  if (command.kind === "ls")
    return `The result holds the first ${rows} rows${reason}: to read on, run ${s3ReadOnCommand({
      bucket: command.bucket,
      prefix: command.prefix,
      delimiter: !command.recursive,
      startingToken: token,
    })}.`;
  return `The result holds the first ${rows} rows${reason}: to read on, run the command again with --starting-token ${token}.`;
}

/** The CLI's `ls` name of a folder: the segment before its last slash, and a slash; found without splitting it. */
function folderName(prefix: string): string {
  const end = prefix.lastIndexOf("/");
  return end < 0 ? `${prefix}/` : `${prefix.slice(prefix.lastIndexOf("/", end - 1) + 1, end)}/`;
}

const lastSegment = (key: string): string => key.slice(key.lastIndexOf("/") + 1);

function lsObjects(
  command: LsCommand,
  outcome: ObjectsOutcome,
  parsed: ParsedS3Command,
  executionTime: number,
): QueryResult {
  const cells = cellBound();
  const rows = outcome.entries.map(
    (entry): Row =>
      entry.kind === "prefix"
        ? {
            kind: "prefix",
            last_modified: null,
            size: null,
            name: cells.text(folderName(entry.prefix)),
            key: cells.text(entry.prefix),
          }
        : {
            kind: "object",
            last_modified: cells.optional(entry.object.lastModified, lsDate),
            size: command.humanReadable ? humanReadableSize(entry.object.size) : entry.object.size,
            name: cells.text(command.recursive ? entry.object.key : lastSegment(entry.object.key)),
            key: cells.text(entry.object.key),
          },
  );
  let summary: Notice;
  if (command.summarize) {
    const found = outcome.entries.flatMap((entry) => (entry.kind === "object" ? [entry.object.size] : []));
    const total = found.reduce((sum, size) => sum + size, 0);
    const size = command.humanReadable ? humanReadableSize(total) : String(total);
    const early = outcome.stop === "complete" ? "" : " These totals count the rows shown only.";
    summary = `Total Objects: ${found.length}. Total Size: ${size}.${early}`;
  }
  return grid(
    ["kind", "last_modified", "size", "name", "key"],
    rows,
    [
      readOnNotice(command, outcome),
      summary,
      outcome.entries.length === 0 && outcome.stop === "complete" ? S3_CONSOLE_NOTICES.noMatch : undefined,
      undecodableNotice(outcome.undecodable),
      cells.notice(),
    ],
    parsed,
    executionTime,
    { last_modified: "timestamp" },
  );
}

function apiObjects(
  command: S3ConsoleCommand,
  outcome: ObjectsOutcome,
  parsed: ParsedS3Command,
  executionTime: number,
): QueryResult {
  const cells = cellBound();
  const rows = outcome.entries.map(
    (entry): Row =>
      entry.kind === "prefix"
        ? {
            Kind: "CommonPrefix",
            Key: cells.text(entry.prefix),
            Size: null,
            LastModified: null,
            ETag: null,
            StorageClass: null,
          }
        : {
            Kind: "Object",
            Key: cells.text(entry.object.key),
            Size: entry.object.size,
            LastModified: cells.optional(entry.object.lastModified, isoUtc),
            ETag: cells.optional(entry.object.etag, cliEtag),
            StorageClass: cells.optional(entry.object.storageClass),
          },
  );
  return grid(
    ["Kind", "Key", "Size", "LastModified", "ETag", "StorageClass"],
    rows,
    [readOnNotice(command, outcome), undecodableNotice(outcome.undecodable), cells.notice()],
    parsed,
    executionTime,
    { LastModified: "timestamp" },
  );
}

/** The `Field`/`Value` rows of a HEAD of an object: each field the core's answer carries, in a fixed order. */
function objectHeadRows(head: ObjectHead): [string, unknown][] {
  const rows: [string, unknown][] = [];
  const add = (field: string, value: unknown): void => {
    if (value !== null) rows.push([field, value]);
  };
  add("ContentLength", head.size);
  add("ETag", head.etag === null ? null : cliEtag(head.etag));
  add("LastModified", head.lastModified === null ? null : isoUtc(head.lastModified));
  add("ContentType", head.contentType);
  add("ContentEncoding", head.contentEncoding);
  add("StorageClass", head.storageClass);
  add("VersionId", head.versionId);
  add("DeleteMarker", head.deleteMarker ? true : null);
  add("TagCount", head.taggingCount);
  add("ServerSideEncryption", head.serverSideEncryption);
  add("Restore", head.restore);
  add("ArchiveStatus", head.archiveStatus);
  add("MissingMeta", head.missingMetadata);
  for (const name of Object.keys(head.userMetadata).sort()) {
    for (const value of head.userMetadata[name]) rows.push([`Metadata.${name}`, value]);
  }
  return rows;
}

function fieldValue(
  pairs: readonly [string, unknown][],
  notices: readonly Notice[],
  parsed: ParsedS3Command,
  executionTime: number,
): QueryResult {
  const cells = cellBound();
  const rows = pairs.map(
    ([field, value]): Row => ({
      Field: cells.text(field),
      Value: typeof value === "string" ? cells.text(value) : value,
    }),
  );
  return grid(["Field", "Value"], rows, [...notices, cells.notice()], parsed, executionTime);
}

type BucketsOutcome = Extract<S3Outcome, { kind: "buckets" }>;

/** A bucket listing: the `ls` names and dates, or the `s3api` ones. */
function bucketsGrid(
  command: S3ConsoleCommand,
  outcome: BucketsOutcome,
  parsed: ParsedS3Command,
  executionTime: number,
): QueryResult {
  const cells = cellBound();
  const asLs = command.kind === "ls";
  const [nameField, dateField] = asLs ? ["name", "creation_date"] : ["Name", "CreationDate"];
  const rows = outcome.buckets.map(
    (bucket): Row =>
      asLs
        ? { creation_date: cells.optional(bucket.created, lsDate), name: cells.text(bucket.name) }
        : { Name: cells.text(bucket.name), CreationDate: cells.optional(bucket.created, isoUtc) },
  );
  return grid(
    asLs ? [dateField, nameField] : [nameField, dateField],
    rows,
    [
      outcome.pinned === undefined
        ? undefined
        : `This connection is pinned to bucket ${outcome.pinned}, so Studio lists that bucket alone and sends no ListBuckets.`,
      outcome.cut
        ? `The server lists more buckets than this result holds, so Studio shows the first ${count(rows.length)} by name: narrow the list with --prefix.`
        : undefined,
      outcome.truncated ? S3_CONSOLE_NOTICES.bucketsNotAllListed : undefined,
      undecodableNotice(outcome.invalidNames),
      cells.notice(),
    ],
    parsed,
    executionTime,
    { [dateField]: "timestamp" },
  );
}

/** A preview: the preview engine's console result, with the notices about the command after its own. */
function previewGrid(preview: S3Preview, parsed: ParsedS3Command, executionTime: number): QueryResult {
  const base = previewQueryResult(preview, executionTime);
  const own = [matchedNotice(parsed.matched), noOpNotice(parsed.noOps)]
    .filter((notice): notice is string => notice !== undefined)
    .map((message) => ({ message }));
  const warnings = [...(base.warnings ?? []), ...own];
  return { ...base, ...(warnings.length === 0 ? {} : { warnings }) };
}

/** The outcome of one run as its grid. */
export function s3Result(outcome: S3Outcome, parsed: ParsedS3Command, executionTime: number): QueryResult {
  const command = parsed.command;
  switch (outcome.kind) {
    case "buckets":
      return bucketsGrid(command, outcome, parsed, executionTime);
    case "objects":
      return command.kind === "ls"
        ? lsObjects(command, outcome, parsed, executionTime)
        : apiObjects(command, outcome, parsed, executionTime);
    case "versions": {
      const cells = cellBound();
      const { listing } = outcome;
      const rows: Row[] = [
        ...listing.prefixes.map(
          (name): Row => ({
            Kind: "CommonPrefix",
            Key: cells.text(name),
            VersionId: null,
            IsLatest: null,
            LastModified: null,
            Size: null,
            ETag: null,
          }),
        ),
        ...listing.entries.map(
          (entry): Row => ({
            Kind: entry.deleteMarker ? "DeleteMarker" : "Version",
            Key: cells.text(entry.key),
            VersionId: cells.optional(entry.versionId),
            IsLatest: entry.isLatest,
            LastModified: cells.optional(entry.lastModified, isoUtc),
            Size: entry.size,
            ETag: cells.optional(entry.etag, cliEtag),
          }),
        ),
      ];
      return grid(
        ["Kind", "Key", "VersionId", "IsLatest", "LastModified", "Size", "ETag"],
        rows,
        [
          listing.isTruncated || outcome.cut ? S3_CONSOLE_NOTICES.moreVersions : undefined,
          undecodableNotice(listing.undecodable),
          cells.notice(),
        ],
        parsed,
        executionTime,
        { LastModified: "timestamp", IsLatest: "boolean" },
      );
    }
    case "bucket-head":
      return outcome.head.bucketRegion === null
        ? fieldValue([], [S3_CONSOLE_NOTICES.bucketNoRegion], parsed, executionTime)
        : fieldValue([["BucketRegion", outcome.head.bucketRegion]], [], parsed, executionTime);
    case "object-head":
      return fieldValue(
        objectHeadRows(outcome.head),
        [outcome.head.headersCut ? S3_CONSOLE_NOTICES.headersCut : undefined],
        parsed,
        executionTime,
      );
    case "location":
      return fieldValue([["LocationConstraint", outcome.region]], [], parsed, executionTime);
    case "versioning": {
      const pairs: [string, unknown][] = [];
      if (outcome.state.status !== null) pairs.push(["Status", outcome.state.status]);
      if (outcome.state.mfaDelete !== null) pairs.push(["MFADelete", outcome.state.mfaDelete]);
      return fieldValue(
        pairs,
        [outcome.state.status === null ? S3_CONSOLE_NOTICES.versioningNever : undefined],
        parsed,
        executionTime,
      );
    }
    case "tags": {
      const cells = cellBound();
      const { tags } = outcome;
      const rows = tags
        .slice(0, S3_RESULT_MAX_ROWS)
        .map((tag): Row => ({ Key: cells.text(tag.key), Value: cells.text(tag.value) }));
      return grid(
        ["Key", "Value"],
        rows,
        [
          rows.length === 0 ? S3_CONSOLE_NOTICES.noTags : undefined,
          tags.length > rows.length
            ? S3_CONSOLE_NOTICES.tagsCut.replace("{total}", count(tags.length)).replace("{shown}", count(rows.length))
            : undefined,
          cells.notice(),
        ],
        parsed,
        executionTime,
      );
    }
    case "preview":
      return previewGrid(outcome.preview, parsed, executionTime);
  }
}
