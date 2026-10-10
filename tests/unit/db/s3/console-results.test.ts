/**
 * Each console command's grid, from fixed outcomes built from the core's types: field order, the
 * AWS CLI's `ls` names, sizes and dates, every notice, the cell bound on every cell the server wrote, the row bound
 * on the tags the core does not cut, and `warnings` absent when there is no notice.
 */
import { describe, expect, test } from "bun:test";
import type { ObjectHead } from "@/lib/db/providers/objectstore/s3/client";
import {
  type ParsedS3Command,
  parseS3Command,
  type S3ParseContext,
} from "@/lib/db/providers/objectstore/s3/console/commands";
import { S3_RESULT_MAX_ROWS } from "@/lib/db/providers/objectstore/s3/console/constants";
import { s3ReadOnCommand } from "@/lib/db/providers/objectstore/s3/console/generators";
import {
  S3_CONSOLE_NOTICES,
  type S3ListedEntry,
  type S3Outcome,
  s3Result,
} from "@/lib/db/providers/objectstore/s3/console/results";
import { encodeS3StartingToken } from "@/lib/db/providers/objectstore/s3/console/token";
import { previewQueryResult } from "@/lib/db/providers/objectstore/s3/preview-render";

const SERVER: S3ParseContext = { endpoint: "http://localhost:9000", region: "us-east-1", readOnly: false };
const WHEN = "2026-01-02T03:04:05.000Z";

function parsed(text: string, context: S3ParseContext = {}): ParsedS3Command {
  const result = parseS3Command(text, context);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.parsed;
}

const messages = (outcome: S3Outcome, text: string, context: S3ParseContext = {}): string[] =>
  (s3Result(outcome, parsed(text, context), 1).warnings ?? []).map((warning) => warning.message);

const object = (key: string, size = 0, extra: Partial<{ etag: string; storageClass: string }> = {}): S3ListedEntry => ({
  kind: "object",
  object: { key, size, lastModified: WHEN, ...extra },
});
const prefix = (name: string): S3ListedEntry => ({ kind: "prefix", prefix: name });

const objects = (
  entries: readonly S3ListedEntry[],
  extra: Partial<Extract<S3Outcome, { kind: "objects" }>> = {},
): S3Outcome => ({
  kind: "objects",
  entries,
  stop: "complete",
  requests: 1,
  undecodable: 0,
  ...extra,
});

const HEAD: ObjectHead = {
  size: 1280,
  etag: "9b2cf535f27731c974343645a3985328-3",
  partsFromEtag: 3,
  lastModified: WHEN,
  contentType: "text/csv",
  contentEncoding: "gzip",
  storageClass: "STANDARD",
  versionId: "v1",
  deleteMarker: true,
  taggingCount: 2,
  serverSideEncryption: "AES256",
  restore: 'ongoing-request="false"',
  archiveStatus: "ARCHIVE_ACCESS",
  userMetadata: { owner: ["ana"], color: ["red", "blue"], "a-b": ["x"] },
  missingMetadata: 1,
  headersCut: true,
};

describe("bucket listings", () => {
  const listing: S3Outcome = {
    kind: "buckets",
    buckets: [{ name: "a", created: WHEN }, { name: "b" }],
    cut: false,
    truncated: false,
    invalidNames: 0,
  };

  test("ls without a path: creation_date and name, in the CLI's date form", () => {
    const result = s3Result(listing, parsed("aws s3 ls"), 7);
    expect(result).toEqual({
      fields: ["creation_date", "name"],
      rows: [
        { creation_date: "2026-01-02 03:04:05", name: "a" },
        { creation_date: null, name: "b" },
      ],
      rowCount: 2,
      executionTime: 7,
      columnTypes: { creation_date: "timestamp" },
    });
  });

  test("list-buckets: Name and CreationDate, with the cut, the unlisted-buckets and the undecodable-names notices", () => {
    const outcome: S3Outcome = { ...listing, cut: true, truncated: true, invalidNames: 2 } as S3Outcome;
    const result = s3Result(outcome, parsed("aws s3api list-buckets --max-items 2"), 1);
    expect(result.fields).toEqual(["Name", "CreationDate"]);
    expect(result.rows).toEqual([
      { Name: "a", CreationDate: WHEN },
      { Name: "b", CreationDate: null },
    ]);
    expect(result.columnTypes).toEqual({ CreationDate: "timestamp" });
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      "The server lists more buckets than this result holds, so Studio shows the first 2 by name: narrow the list with --prefix.",
      S3_CONSOLE_NOTICES.bucketsNotAllListed,
      "2 names on the pages read are not UTF-8 text or not a valid name, so Studio does not list them.",
    ]);
  });

  test("a creation date longer than the cell bound is cut and counted, in ls and in list-buckets", () => {
    const outcome: S3Outcome = { ...listing, buckets: [{ name: "a", created: "c".repeat(70_000) }] };
    const ls = s3Result(outcome, parsed("aws s3 ls"), 1);
    expect((ls.rows[0].creation_date as string).length).toBe(65_536);
    expect(ls.warnings?.map((warning) => warning.message)).toEqual(["1 cell(s) were cut at 65,536 characters."]);
    const api = s3Result(outcome, parsed("aws s3api list-buckets"), 1);
    expect((api.rows[0].CreationDate as string).length).toBe(65_536);
    expect(api.warnings?.map((warning) => warning.message)).toEqual(["1 cell(s) were cut at 65,536 characters."]);
  });

  test("a pinned connection answers its bucket alone with the pinned-bucket notice", () => {
    const pinned: S3Outcome = {
      kind: "buckets",
      buckets: [{ name: "sales" }],
      cut: false,
      truncated: false,
      invalidNames: 0,
      pinned: "sales",
    };
    expect(messages(pinned, "aws s3api list-buckets")).toEqual([
      "This connection is pinned to bucket sales, so Studio lists that bucket alone and sends no ListBuckets.",
    ]);
  });
});

describe("ls on a path", () => {
  const entries = [prefix("2026/q1/"), object("2026/a.csv", 1280), object("2026/", 0)];

  test("folders then objects, with the CLI's names and Studio's full key", () => {
    const result = s3Result(objects(entries), parsed("aws s3 ls s3://sales/2026/"), 1);
    expect(result.fields).toEqual(["kind", "last_modified", "size", "name", "key"]);
    expect(result.rows).toEqual([
      { kind: "prefix", last_modified: null, size: null, name: "q1/", key: "2026/q1/" },
      { kind: "object", last_modified: "2026-01-02 03:04:05", size: 1280, name: "a.csv", key: "2026/a.csv" },
      { kind: "object", last_modified: "2026-01-02 03:04:05", size: 0, name: "", key: "2026/" },
    ]);
    expect(result.columnTypes).toEqual({ last_modified: "timestamp" });
    expect(result.warnings).toBeUndefined();
  });

  test("--recursive names each object by its full key", () => {
    const result = s3Result(objects([object("2026/q1/a.csv")]), parsed("aws s3 ls s3://sales/ --recursive"), 1);
    expect(result.rows[0]).toMatchObject({ name: "2026/q1/a.csv" });
  });

  test("--human-readable writes the CLI's size, and --summarize adds the totals notice", () => {
    const result = s3Result(objects(entries), parsed("aws s3 ls s3://sales/2026/ --human-readable --summarize"), 1);
    expect(result.rows[1]).toMatchObject({ size: "1.2 KiB" });
    expect(result.columnTypes).toEqual({ last_modified: "timestamp" });
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["Total Objects: 2. Total Size: 1.2 KiB."]);
    expect(messages(objects(entries), "aws s3 ls s3://sales/2026/ --summarize")).toEqual([
      "Total Objects: 2. Total Size: 1280.",
    ]);
  });

  test("an early stop names the list-objects-v2 command that reads on, and the totals say they count the rows shown", () => {
    const outcome = objects(entries, { stop: "rows", nextToken: "t1" });
    const token = encodeS3StartingToken("t1");
    expect(messages(outcome, "aws s3 ls s3://sales/2026/ --summarize")).toEqual([
      `The result holds the first 3 rows, the most a Studio result holds: to read on, run ${s3ReadOnCommand({ bucket: "sales", prefix: "2026/", delimiter: true, startingToken: token })}.`,
      "Total Objects: 2. Total Size: 1280. These totals count the rows shown only.",
    ]);
    expect(messages(outcome, "aws s3 ls s3://sales/2026/ --recursive")[0]).toBe(
      `The result holds the first 3 rows, the most a Studio result holds: to read on, run aws s3api list-objects-v2 --bucket sales --prefix 2026/ --starting-token ${token}.`,
    );
  });

  test("a prefix that matched nothing gives the no-match notice, and undecodable names their own notice", () => {
    expect(messages(objects([]), "aws s3 ls s3://sales/none")).toEqual([
      "No key and no folder begins with this prefix.",
    ]);
    expect(messages(objects([object("a")], { undecodable: 3 }), "aws s3 ls s3://sales/")).toEqual([
      "3 names on the pages read are not UTF-8 text or not a valid name, so Studio does not list them.",
    ]);
  });

  test("an empty run that stopped at the page cap reads on and does not say nothing matched", () => {
    const outcome = objects([], { stop: "page-cap", nextToken: "t", requests: 50 });
    const token = encodeS3StartingToken("t");
    expect(messages(outcome, "aws s3 ls s3://sales/x/")).toEqual([
      `The result holds the first 0 rows, after 50 requests, the most one run sends: to read on, run ${s3ReadOnCommand({ bucket: "sales", prefix: "x/", delimiter: true, startingToken: token })}.`,
    ]);
  });

  test("a folder's name is the segment before its last slash, an empty one included", () => {
    const result = s3Result(
      objects([prefix("a/b/c/"), prefix("a//"), prefix("/"), prefix("x")]),
      parsed("aws s3 ls s3://sales/"),
      1,
    );
    expect(result.rows.map((row) => row.name)).toEqual(["c/", "/", "/", "x/"]);
  });

  test("a date the server wrote that does not parse is kept and bounded like any other cell", () => {
    const outcome = objects([{ kind: "object", object: { key: "a", size: 1, lastModified: "d".repeat(70_000) } }]);
    const result = s3Result(outcome, parsed("aws s3 ls s3://sales/"), 1);
    expect((result.rows[0].last_modified as string).length).toBe(65_536);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["1 cell(s) were cut at 65,536 characters."]);
  });
});

describe("list-objects-v2", () => {
  test("CommonPrefix rows then Object rows, the ETag quoted and the date ISO", () => {
    const outcome = objects([
      prefix("2026/"),
      object("a.csv", 5, { etag: "abc", storageClass: "STANDARD" }),
      object("b.csv"),
    ]);
    const result = s3Result(outcome, parsed("aws s3api list-objects-v2 --bucket sales"), 1);
    expect(result.fields).toEqual(["Kind", "Key", "Size", "LastModified", "ETag", "StorageClass"]);
    expect(result.rows).toEqual([
      { Kind: "CommonPrefix", Key: "2026/", Size: null, LastModified: null, ETag: null, StorageClass: null },
      { Kind: "Object", Key: "a.csv", Size: 5, LastModified: WHEN, ETag: '"abc"', StorageClass: "STANDARD" },
      { Kind: "Object", Key: "b.csv", Size: 0, LastModified: WHEN, ETag: null, StorageClass: null },
    ]);
    expect(result.columnTypes).toEqual({ LastModified: "timestamp" });
  });

  test("the read-on notice by stop reason, with the CLI-form token", () => {
    const token = encodeS3StartingToken("t9");
    const stopped = (stop: "rows" | "page-cap", requests = 1) =>
      objects([object("a"), object("b")], { stop, nextToken: "t9", requests });
    expect(messages(stopped("rows"), "aws s3api list-objects-v2 --bucket b --max-items 2")).toEqual([
      `The result holds the first 2 rows: to read on, run the command again with --starting-token ${token}.`,
    ]);
    expect(messages(stopped("rows"), "aws s3api list-objects-v2 --bucket b")).toEqual([
      `The result holds the first 2 rows, the most a Studio result holds: to read on, run the command again with --starting-token ${token}.`,
    ]);
    expect(messages(stopped("page-cap", 50), "aws s3api list-objects-v2 --bucket b")).toEqual([
      `The result holds the first 2 rows, after 50 requests, the most one run sends: to read on, run the command again with --starting-token ${token}.`,
    ]);
  });

  test("a cell longer than 65,536 characters is cut on a character and counted", () => {
    const long = `${"k".repeat(65_535)}\ud83d\ude00tail`;
    const result = s3Result(objects([object(long)]), parsed("aws s3api list-objects-v2 --bucket b"), 1);
    expect((result.rows[0].Key as string).length).toBe(65_535);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["1 cell(s) were cut at 65,536 characters."]);
  });

  test("a StorageClass, an ETag and a date longer than the cell bound are each cut and counted", () => {
    const long = "s".repeat(70_000);
    const outcome = objects([
      { kind: "object", object: { key: "a", size: 1, lastModified: long, etag: long, storageClass: long } },
    ]);
    const result = s3Result(outcome, parsed("aws s3api list-objects-v2 --bucket b"), 1);
    const row = result.rows[0];
    expect([row.LastModified, row.ETag, row.StorageClass].map((cell) => (cell as string).length)).toEqual([
      65_536, 65_536, 65_536,
    ]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["3 cell(s) were cut at 65,536 characters."]);
  });
});

describe("list-object-versions", () => {
  const listing = {
    entries: [
      { key: "a.csv", versionId: "v2", isLatest: true, deleteMarker: false, size: 5, lastModified: WHEN, etag: "e2" },
      { key: "a.csv", versionId: "v1", isLatest: false, deleteMarker: true, size: null },
    ],
    prefixes: ["2026/"],
    undecodable: 0,
    isTruncated: false,
  };

  test("CommonPrefix rows, then versions and delete markers in document order", () => {
    const result = s3Result(
      { kind: "versions", listing, cut: false },
      parsed("aws s3api list-object-versions --bucket b"),
      1,
    );
    expect(result.fields).toEqual(["Kind", "Key", "VersionId", "IsLatest", "LastModified", "Size", "ETag"]);
    expect(result.rows).toEqual([
      {
        Kind: "CommonPrefix",
        Key: "2026/",
        VersionId: null,
        IsLatest: null,
        LastModified: null,
        Size: null,
        ETag: null,
      },
      { Kind: "Version", Key: "a.csv", VersionId: "v2", IsLatest: true, LastModified: WHEN, Size: 5, ETag: '"e2"' },
      {
        Kind: "DeleteMarker",
        Key: "a.csv",
        VersionId: "v1",
        IsLatest: false,
        LastModified: null,
        Size: null,
        ETag: null,
      },
    ]);
    expect(result.columnTypes).toEqual({ LastModified: "timestamp", IsLatest: "boolean" });
    expect(result.warnings).toBeUndefined();
  });

  test("a truncated page and a page cut client-side both give the more-versions notice and no token", () => {
    const text = "aws s3api list-object-versions --bucket b";
    expect(messages({ kind: "versions", listing: { ...listing, isTruncated: true }, cut: false }, text)).toEqual([
      S3_CONSOLE_NOTICES.moreVersions,
    ]);
    expect(messages({ kind: "versions", listing, cut: true }, text)).toEqual([S3_CONSOLE_NOTICES.moreVersions]);
  });

  test("a version id, an ETag and a date longer than the cell bound are each cut and counted", () => {
    const long = "v".repeat(70_000);
    const entry = {
      key: "a",
      versionId: long,
      isLatest: true,
      deleteMarker: false,
      size: 1,
      lastModified: long,
      etag: long,
    };
    const result = s3Result(
      { kind: "versions", listing: { entries: [entry], prefixes: [], undecodable: 0, isTruncated: false }, cut: false },
      parsed("aws s3api list-object-versions --bucket b"),
      1,
    );
    const row = result.rows[0];
    expect([row.VersionId, row.LastModified, row.ETag].map((cell) => (cell as string).length)).toEqual([
      65_536, 65_536, 65_536,
    ]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["3 cell(s) were cut at 65,536 characters."]);
  });
});

describe("Field and Value grids, tags", () => {
  test("head-bucket answers the region when the server sent one, else the no-region notice", () => {
    const text = "aws s3api head-bucket --bucket b";
    expect(s3Result({ kind: "bucket-head", head: { bucketRegion: "eu-west-1" } }, parsed(text), 1).rows).toEqual([
      { Field: "BucketRegion", Value: "eu-west-1" },
    ]);
    const none = s3Result({ kind: "bucket-head", head: { bucketRegion: null } }, parsed(text), 1);
    expect(none.rows).toEqual([]);
    expect(none.fields).toEqual(["Field", "Value"]);
    expect(none.warnings).toEqual([{ message: S3_CONSOLE_NOTICES.bucketNoRegion }]);
  });

  test("head-object lists every field the core's answer carries, metadata sorted by name, and the headers-cut notice", () => {
    const result = s3Result({ kind: "object-head", head: HEAD }, parsed("aws s3api head-object --bucket b --key k"), 1);
    expect(result.rows).toEqual([
      { Field: "ContentLength", Value: 1280 },
      { Field: "ETag", Value: '"9b2cf535f27731c974343645a3985328-3"' },
      { Field: "LastModified", Value: WHEN },
      { Field: "ContentType", Value: "text/csv" },
      { Field: "ContentEncoding", Value: "gzip" },
      { Field: "StorageClass", Value: "STANDARD" },
      { Field: "VersionId", Value: "v1" },
      { Field: "DeleteMarker", Value: true },
      { Field: "TagCount", Value: 2 },
      { Field: "ServerSideEncryption", Value: "AES256" },
      { Field: "Restore", Value: 'ongoing-request="false"' },
      { Field: "ArchiveStatus", Value: "ARCHIVE_ACCESS" },
      { Field: "MissingMeta", Value: 1 },
      { Field: "Metadata.a-b", Value: "x" },
      { Field: "Metadata.color", Value: "red" },
      { Field: "Metadata.color", Value: "blue" },
      { Field: "Metadata.owner", Value: "ana" },
    ]);
    expect(result.warnings).toEqual([{ message: S3_CONSOLE_NOTICES.headersCut }]);
  });

  test("head-object bounds a metadata name and value like any other cell", () => {
    const long = "m".repeat(70_000);
    const head: ObjectHead = { ...HEAD, userMetadata: { [long]: [long] }, headersCut: false };
    const result = s3Result({ kind: "object-head", head }, parsed("aws s3api head-object --bucket b --key k"), 1);
    const last = result.rows[result.rows.length - 1];
    expect([(last.Field as string).length, (last.Value as string).length]).toEqual([65_536, 65_536]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(["2 cell(s) were cut at 65,536 characters."]);
  });

  test("head-object leaves out what the core could not read, ContentLength included", () => {
    const bare: ObjectHead = {
      ...HEAD,
      size: null,
      etag: null,
      partsFromEtag: null,
      lastModified: null,
      contentType: null,
      contentEncoding: null,
      storageClass: null,
      versionId: null,
      deleteMarker: false,
      taggingCount: null,
      serverSideEncryption: null,
      restore: null,
      archiveStatus: null,
      userMetadata: {},
      missingMetadata: null,
      headersCut: false,
    };
    const result = s3Result({ kind: "object-head", head: bare }, parsed("aws s3api head-object --bucket b --key k"), 1);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  test("get-bucket-location answers the core's normalised region", () => {
    expect(
      s3Result({ kind: "location", region: "us-east-1" }, parsed("aws s3api get-bucket-location --bucket b"), 1).rows,
    ).toEqual([{ Field: "LocationConstraint", Value: "us-east-1" }]);
  });

  test("get-bucket-versioning answers Status and MFADelete, or a notice when versioning was never on", () => {
    const text = "aws s3api get-bucket-versioning --bucket b";
    expect(
      s3Result({ kind: "versioning", state: { status: "Enabled", mfaDelete: "Disabled" } }, parsed(text), 1).rows,
    ).toEqual([
      { Field: "Status", Value: "Enabled" },
      { Field: "MFADelete", Value: "Disabled" },
    ]);
    const never = s3Result({ kind: "versioning", state: { status: null, mfaDelete: null } }, parsed(text), 1);
    expect(never.rows).toEqual([]);
    expect(never.warnings).toEqual([{ message: S3_CONSOLE_NOTICES.versioningNever }]);
  });

  test("get-object-tagging answers Key and Value in server order, or the no-tags notice", () => {
    const text = "aws s3api get-object-tagging --bucket b --key k";
    const result = s3Result(
      {
        kind: "tags",
        tags: [
          { key: "z", value: "1" },
          { key: "a", value: "2" },
        ],
      },
      parsed(text),
      1,
    );
    expect(result.fields).toEqual(["Key", "Value"]);
    expect(result.rows).toEqual([
      { Key: "z", Value: "1" },
      { Key: "a", Value: "2" },
    ]);
    expect(messages({ kind: "tags", tags: [] }, text)).toEqual([S3_CONSOLE_NOTICES.noTags]);
  });

  test("get-object-tagging shows at most the rows a Studio result holds and counts the rest", () => {
    const tags = Array.from({ length: S3_RESULT_MAX_ROWS + 2 }, (_, index) => ({ key: `k${index}`, value: "v" }));
    const result = s3Result({ kind: "tags", tags }, parsed("aws s3api get-object-tagging --bucket b --key k"), 1);
    expect(result.rowCount).toBe(S3_RESULT_MAX_ROWS);
    expect(result.rows[S3_RESULT_MAX_ROWS - 1]).toEqual({ Key: `k${S3_RESULT_MAX_ROWS - 1}`, Value: "v" });
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      "The object has 502 tags, and the result holds the first 500, the most a Studio result holds.",
    ]);
  });
});

describe("preview, and the notices about the command", () => {
  test("preview is the preview engine's console result, with the command's own notices after its own", () => {
    const preview = { kind: "empty", notices: [] } as const;
    const base = previewQueryResult(preview, 4);
    const result = s3Result({ kind: "preview", preview }, parsed("preview s3://b/k --output json"), 4);
    expect(result).toEqual({
      ...base,
      warnings: [...(base.warnings ?? []), { message: "--output changes nothing in Studio: every result is a grid." }],
    });
  });

  test("the matched-options notice names the options in the order typed", () => {
    const outcome: S3Outcome = { kind: "location", region: "us-east-1" };
    expect(messages(outcome, "aws s3api get-bucket-location --bucket b --region us-east-1", SERVER)).toEqual([
      "--region names this connection's own region, so it changes nothing: the connection decides where Studio connects and which region signs.",
    ]);
    expect(
      messages(
        outcome,
        "aws --region us-east-1 s3api get-bucket-location --bucket b --endpoint-url http://localhost:9000",
        SERVER,
      ),
    ).toEqual([
      "--region and --endpoint-url name this connection's own region and endpoint, so they change nothing: the connection decides where Studio connects and which region signs.",
    ]);
  });

  test("the no-op options notice names the options in the order typed, after the matched-options notice", () => {
    const outcome: S3Outcome = { kind: "location", region: "us-east-1" };
    expect(messages(outcome, "aws s3api get-bucket-location --bucket b --no-cli-pager")).toEqual([
      "--no-cli-pager changes nothing in Studio: every result is a grid.",
    ]);
    expect(
      messages(
        outcome,
        "aws s3api get-bucket-location --bucket b --output json --color off --region us-east-1",
        SERVER,
      ),
    ).toEqual([
      "--region names this connection's own region, so it changes nothing: the connection decides where Studio connects and which region signs.",
      "--output and --color change nothing in Studio: every result is a grid.",
    ]);
  });

  test("the fixed notices, verbatim", () => {
    expect(S3_CONSOLE_NOTICES).toEqual({
      bucketsNotAllListed:
        "The server holds more buckets than it listed in one answer, and Studio does not ask for the rest in this version: put a bucket's name in the Bucket field of the connection to read it.",
      noMatch: "No key and no folder begins with this prefix.",
      bucketNoRegion: "The bucket exists and this connection may read it: the server sent no region for it.",
      versioningNever: "Versioning was never turned on for this bucket: S3 answers no Status.",
      noTags: "The object has no tags.",
      moreVersions: "The server holds more versions than this page shows: narrow --prefix to see the rest.",
      headersCut: "The server sent more headers than Studio reads, so some fields may be missing.",
    });
  });
});
