/**
 * The S3 provider's numbers: the bounds derived from other bounds hold their derivation, the
 * one number shared with the query limiter equals it, and the three connection patterns admit and refuse what
 * the connection form documents.
 */
import { describe, expect, test } from "bun:test";
import {
  S3_ACCESS_KEY_ID_PATTERN,
  S3_BUCKET_PATTERN,
  S3_CURSOR_PAYLOAD_MAX_BYTES,
  S3_CURSOR_TEXT_MAX_CHARS,
  S3_DEFAULT_REGION,
  S3_LIMITER_OPTIONS,
  S3_MAX_SOCKETS,
  S3_REGION_PATTERN,
  S3_RESULT_MAX_ROWS,
  S3_TYPE,
} from "@/lib/db/providers/objectstore/s3/constants";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { s3Connection } from "../../../helpers/s3-connection";

describe("derived bounds", () => {
  test("the cursor text bound is the spelling prefix plus the base64url of the payload bound", () => {
    expect(S3_CURSOR_TEXT_MAX_CHARS).toBe("s3c:1:".length + Math.ceil((S3_CURSOR_PAYLOAD_MAX_BYTES * 4) / 3));
  });

  test("the result row bound is the shared query limit, written as a literal for browser-safe modules", () => {
    expect(S3_RESULT_MAX_ROWS).toBe(DEFAULT_QUERY_LIMIT);
  });

  test("the transport's socket bound equals the per-provider permit bound, so a permit never waits on a socket", () => {
    expect(S3_MAX_SOCKETS).toBe(S3_LIMITER_OPTIONS.perProvider);
    expect(S3_LIMITER_OPTIONS).toEqual({ perProvider: 4, perEngine: 16, queueDepth: 64 });
    expect(Object.isFrozen(S3_LIMITER_OPTIONS)).toBe(true);
  });
});

describe("the access key ID pattern", () => {
  test.each([
    "AKIAIOSFODNN7EXAMPLE",
    "GK5e3a7b0c11d2e4f6a8b0c2d4",
    "s3proberoot",
    "a!b#c$d%e&f'g(h)i*j+k-l.m:n;o<p>q?r@s[t]u^v_w`x{y|z}~",
  ])("admits %p", (id) => {
    expect(S3_ACCESS_KEY_ID_PATTERN.test(id)).toBe(true);
  });

  test.each(["has space", "a,b", "a=b", "a/b", "", "tab\there", "café"])("refuses %p", (id) => {
    expect(S3_ACCESS_KEY_ID_PATTERN.test(id)).toBe(false);
  });
});

describe("the bucket pattern", () => {
  test.each(["a", "sales", "my.bucket-1_x", "A1", "a".repeat(255)])("admits %p", (bucket) => {
    expect(S3_BUCKET_PATTERN.test(bucket)).toBe(true);
  });

  test.each(["", "..", ".", "-a", "a-", "a b", "a/b", "a".repeat(256), "ü"])("refuses %p", (bucket) => {
    expect(S3_BUCKET_PATTERN.test(bucket)).toBe(false);
  });
});

describe("the region pattern", () => {
  test.each([S3_DEFAULT_REGION, "eu-central-1", "garage-probe", "r".repeat(64)])("admits %p", (region) => {
    expect(S3_REGION_PATTERN.test(region)).toBe(true);
  });

  test.each(["", "us east", "us.east", "r".repeat(65), "   "])("refuses %p", (region) => {
    expect(S3_REGION_PATTERN.test(region)).toBe(false);
  });
});

test("the test connection helper builds a signed S3 connection to this machine", () => {
  expect(s3Connection({ database: "sales" })).toEqual({
    id: "s3-test",
    name: "S3 test",
    type: S3_TYPE,
    host: "localhost",
    port: 9000,
    user: "AKIDTESTKEY",
    password: "test-secret-key",
    database: "sales",
    createdAt: new Date(0),
  });
});
