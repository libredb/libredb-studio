/**
 * The bounded response headers and the object HEAD reader, on the HEAD header sets
 * measured on MinIO, Garage and RustFS, as PR 1 hands them:
 * names lower-cased, values latin1, only the selected ones.
 */
import { describe, expect, test } from "bun:test";
import type { ResponseHeader } from "@/lib/db/http/node-transport";
import {
  firstHeader,
  headerCount,
  readObjectHead,
  S3_RESPONSE_HEADERS,
} from "@/lib/db/providers/objectstore/s3/headers";

const head = (
  headers: readonly ResponseHeader[],
  fields: { contentType?: string | null; contentEncoding?: string | null; headersTruncated?: boolean } = {},
) =>
  readObjectHead({
    headers,
    contentType: fields.contentType ?? null,
    contentEncoding: fields.contentEncoding ?? null,
    headersTruncated: fields.headersTruncated ?? false,
  });

test("the selection is 19 names and one prefix, inside PR 1's 32 and 8, never location or set-cookie", () => {
  expect(S3_RESPONSE_HEADERS).toEqual({
    names: [
      "content-length",
      "content-range",
      "etag",
      "last-modified",
      "date",
      "accept-ranges",
      "x-amz-version-id",
      "x-amz-delete-marker",
      "x-amz-tagging-count",
      "x-amz-storage-class",
      "x-amz-bucket-region",
      "x-amz-mp-parts-count",
      "x-amz-restore",
      "x-amz-archive-status",
      "x-amz-server-side-encryption",
      "x-amz-missing-meta",
      "x-amz-request-id",
      "x-minio-error-code",
      "x-request-id",
    ],
    prefixes: ["x-amz-meta-"],
  });
});

describe("readObjectHead", () => {
  test("MinIO: a tagged object with user metadata and a version", () => {
    expect(
      head(
        [
          ["accept-ranges", "bytes"],
          ["content-length", "12"],
          ["etag", '"937ec4c10eb20c1f3324ef927697ea66"'],
          ["last-modified", "Fri, 09 Oct 2026 13:13:17 GMT"],
          ["x-amz-request-id", "18DCDEC39CC862DE"],
          ["x-amz-meta-owner", "probe"],
          ["x-amz-meta-project", "libredb"],
          ["x-amz-tagging-count", "2"],
          ["x-amz-version-id", "09ea3790-40bb-4da1-9a35-9ab4c4f93f71"],
          ["date", "Fri, 09 Oct 2026 13:14:43 GMT"],
        ],
        { contentType: "text/plain" },
      ),
    ).toEqual({
      size: 12,
      etag: "937ec4c10eb20c1f3324ef927697ea66",
      partsFromEtag: null,
      lastModified: "2026-10-09T13:13:17.000Z",
      contentType: "text/plain",
      contentEncoding: null,
      storageClass: null,
      versionId: "09ea3790-40bb-4da1-9a35-9ab4c4f93f71",
      deleteMarker: false,
      taggingCount: 2,
      serverSideEncryption: null,
      restore: null,
      archiveStatus: null,
      userMetadata: { owner: ["probe"], project: ["libredb"] },
      missingMetadata: null,
      headersCut: false,
    });
  });

  test("Garage: lower-case headers and no version", () => {
    const answer = head(
      [
        ["last-modified", "Fri, 09 Oct 2026 14:04:23 GMT"],
        ["accept-ranges", "bytes"],
        ["etag", '"76e272a85b3037c386e8293a9b191c8c"'],
        ["content-length", "52"],
        ["date", "Fri, 09 Oct 2026 14:05:10 GMT"],
      ],
      { contentType: "text/csv" },
    );
    expect(answer).toMatchObject({
      size: 52,
      etag: "76e272a85b3037c386e8293a9b191c8c",
      versionId: null,
      taggingCount: null,
      contentType: "text/csv",
    });
  });

  test("RustFS: a multipart ETag gives its part count", () => {
    const answer = head([
      ["content-length", "6291456"],
      ["etag", '"834b9f7f9dd291dbc6083185d4ca07b0-2"'],
      ["x-amz-version-id", "b271e1fe-d5aa-4589-a987-2cc5ba742057"],
    ]);
    expect(answer).toMatchObject({ size: 6291456, etag: "834b9f7f9dd291dbc6083185d4ca07b0-2", partsFromEtag: 2 });
  });

  test("a multipart ETag whose part count is not a safe integer gives no part count", () => {
    const answer = head([["etag", '"834b9f7f9dd291dbc6083185d4ca07b0-99999999999999999999"']]);
    expect(answer).toMatchObject({
      etag: "834b9f7f9dd291dbc6083185d4ca07b0-99999999999999999999",
      partsFromEtag: null,
    });
  });

  test("the first value of each name is read; a repeated x-amz-meta-* keeps every value", () => {
    const answer = head([
      ["content-length", "1"],
      ["content-length", "2"],
      ["x-amz-meta-a", "1"],
      ["x-amz-meta-a", "2"],
    ]);
    expect(answer.size).toBe(1);
    expect(answer.userMetadata).toEqual({ a: ["1", "2"] });
  });

  test("a latin1 value is re-decoded as UTF-8 when that is valid, and kept as received when not", () => {
    const answer = head([
      ["x-amz-meta-word", "cafÃ©"],
      ["x-amz-meta-raw", "ÿþ"],
    ]);
    expect(answer.userMetadata).toEqual({ word: ["café"], raw: ["ÿþ"] });
  });

  test("absent, null and malformed values", () => {
    const answer = head(
      [
        ["content-length", "-1"],
        ["last-modified", "not a date"],
        ["x-amz-version-id", "null"],
        ["x-amz-delete-marker", "TRUE"],
        ["x-amz-tagging-count", "two"],
        ["x-amz-missing-meta", "3"],
        ["x-amz-storage-class", "GLACIER"],
        ["x-amz-server-side-encryption", "AES256"],
        ["x-amz-restore", 'ongoing-request="true"'],
        ["x-amz-archive-status", "ARCHIVE_ACCESS"],
      ],
      { contentEncoding: "gzip", headersTruncated: true },
    );
    expect(answer).toMatchObject({
      size: null,
      etag: null,
      lastModified: "not a date",
      versionId: null,
      deleteMarker: false,
      taggingCount: null,
      missingMetadata: 3,
      storageClass: "GLACIER",
      serverSideEncryption: "AES256",
      restore: 'ongoing-request="true"',
      archiveStatus: "ARCHIVE_ACCESS",
      contentEncoding: "gzip",
      headersCut: true,
    });
  });

  test("a delete marker reads true only for true", () => {
    expect(head([["x-amz-delete-marker", "true"]]).deleteMarker).toBe(true);
  });
});

test("firstHeader and headerCount", () => {
  expect(
    firstHeader(
      [
        ["date", "a"],
        ["date", "b"],
      ],
      "date",
    ),
  ).toBe("a");
  expect(firstHeader([], "date")).toBeUndefined();
  expect(headerCount("12")).toBe(12);
  expect(headerCount("9007199254740993")).toBeNull();
  expect(headerCount(undefined)).toBeNull();
});
