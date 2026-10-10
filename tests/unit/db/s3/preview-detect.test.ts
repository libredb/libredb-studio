/**
 * Format detection of the S3 preview: Content-Encoding first, then the key's extension (a .gz
 * layer marks the inner extension), then magic bytes, then a Content-Type hint that never selects Parquet.
 */
import { describe, expect, test } from "bun:test";
import {
  contentTypeHint,
  encodingLayer,
  extensionOf,
  parsesAsJson,
  sniffMagic,
} from "@/lib/db/providers/objectstore/s3/preview-detect";

describe("encodingLayer", () => {
  test("absent, empty and identity are no layer", () => {
    expect(encodingLayer(undefined)).toEqual({ kind: "none" });
    expect(encodingLayer("")).toEqual({ kind: "none" });
    expect(encodingLayer(" Identity ")).toEqual({ kind: "none" });
  });

  test("gzip and x-gzip, trimmed and in any case, are one gzip layer", () => {
    expect(encodingLayer("gzip")).toEqual({ kind: "gzip" });
    expect(encodingLayer(" GZIP ")).toEqual({ kind: "gzip" });
    expect(encodingLayer("x-gzip")).toEqual({ kind: "gzip" });
  });

  test("any other coding is named when it is short and plain, else described", () => {
    expect(encodingLayer("br")).toEqual({ kind: "other", coding: "br" });
    expect(encodingLayer("aws-chunked+v2")).toEqual({ kind: "other", coding: "aws-chunked+v2" });
    expect(encodingLayer("x".repeat(41))).toEqual({ kind: "other", coding: "of an unrecognised form" });
    expect(encodingLayer("gzip, br")).toEqual({ kind: "other", coding: "of an unrecognised form" });
  });
});

describe("extensionOf", () => {
  test("the extension table, case-insensitive, read from the last segment", () => {
    expect(extensionOf("a/b.parquet")).toEqual({ gzip: false, format: "parquet" });
    expect(extensionOf("b.PARQ")).toEqual({ gzip: false, format: "parquet" });
    expect(extensionOf("b.pq")).toEqual({ gzip: false, format: "parquet" });
    expect(extensionOf("b.Json")).toEqual({ gzip: false, format: "json" });
    expect(extensionOf("b.ndjson")).toEqual({ gzip: false, format: "ndjson" });
    expect(extensionOf("b.jsonl")).toEqual({ gzip: false, format: "ndjson" });
    expect(extensionOf("b.ldjson")).toEqual({ gzip: false, format: "ndjson" });
    expect(extensionOf("b.csv")).toEqual({ gzip: false, format: "csv" });
    expect(extensionOf("b.tsv")).toEqual({ gzip: false, format: "tsv" });
    expect(extensionOf("b.tab")).toEqual({ gzip: false, format: "tsv" });
  });

  test("an unknown extension, none, or a dot only in a folder name places nothing", () => {
    expect(extensionOf("b.txt")).toEqual({ gzip: false });
    expect(extensionOf("b")).toEqual({ gzip: false });
    expect(extensionOf("dir.csv/b")).toEqual({ gzip: false });
    expect(extensionOf("b.constructor")).toEqual({ gzip: false });
  });

  test(".gz and .gzip mark one gzip layer and the extension before them is the inner format", () => {
    expect(extensionOf("orders.csv.gz")).toEqual({ gzip: true, format: "csv" });
    expect(extensionOf("rows.ndjson.GZIP")).toEqual({ gzip: true, format: "ndjson" });
    expect(extensionOf("data.gz")).toEqual({ gzip: true });
  });
});

describe("sniffMagic and contentTypeHint", () => {
  test("1f 8b is gzip, PAR1 at offset 0 is Parquet, anything else nothing", () => {
    expect(sniffMagic(Uint8Array.of(0x1f, 0x8b, 0x08))).toBe("gzip");
    expect(sniffMagic(new TextEncoder().encode("PAR1xyz"))).toBe("parquet");
    expect(sniffMagic(new TextEncoder().encode("PAR"))).toBeUndefined();
    expect(sniffMagic(new TextEncoder().encode("id,name"))).toBeUndefined();
  });

  test("Content-Type hints, with parameters and case ignored; never Parquet", () => {
    expect(contentTypeHint("application/json; charset=utf-8")).toBe("json");
    expect(contentTypeHint("application/x-ndjson")).toBe("ndjson");
    expect(contentTypeHint("application/jsonl")).toBe("ndjson");
    expect(contentTypeHint("application/x-jsonlines")).toBe("ndjson");
    expect(contentTypeHint("Text/CSV")).toBe("csv");
    expect(contentTypeHint("text/tab-separated-values")).toBe("tsv");
    expect(contentTypeHint("application/vnd.apache.parquet")).toBe("text");
    expect(contentTypeHint("binary/octet-stream")).toBe("text");
    expect(contentTypeHint(undefined)).toBe("text");
  });

  test("parsesAsJson is a validity check only", () => {
    expect(parsesAsJson('{"a":1}')).toBe(true);
    expect(parsesAsJson("12")).toBe(true);
    expect(parsesAsJson("not json")).toBe(false);
  });
});
