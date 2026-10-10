/**
 * `s3://bucket/key` as the AWS CLI's ListCommand reads it: the scheme stripped, a scheme-less
 * path read as if it had one, access point ARNs and other schemes refused, and the split at the first slash.
 */
import { describe, expect, test } from "bun:test";
import { readS3Path, S3_PATH_SENTENCES } from "@/lib/db/providers/objectstore/s3/console/paths";

describe("readS3Path", () => {
  test.each([
    ["s3://", "", ""],
    ["", "", ""],
    ["s3://sales", "sales", ""],
    ["s3://sales/", "sales", ""],
    ["s3://sales/2026/", "sales", "2026/"],
    ["s3://sales/2026", "sales", "2026"],
    ["s3://sales/2026/orders.csv", "sales", "2026/orders.csv"],
    ["sales/2026", "sales", "2026"],
    ["sales", "sales", ""],
    ["s3://sales//x", "sales", "/x"],
    ["s3://sales/a b", "sales", "a b"],
  ])("%s reads as bucket %s and key %s", (text, bucket, key) => {
    expect(readS3Path(text)).toEqual({ ok: true, bucket, key });
  });

  test("a key that holds :// after the bucket is read, not refused", () => {
    expect(readS3Path("s3://sales/a://b")).toEqual({ ok: true, bucket: "sales", key: "a://b" });
    expect(readS3Path("s3://sales/x/https://y")).toEqual({ ok: true, bucket: "sales", key: "x/https://y" });
  });

  test("the sentences, verbatim", () => {
    expect(S3_PATH_SENTENCES).toEqual({
      arn: "Studio does not read access points or Outposts, so it refuses a path that begins with arn:: write s3://bucket/prefix.",
      otherScheme: "The path is not an s3:// path: write s3://bucket/prefix.",
      noBucket: "The path names no bucket: write s3://bucket/prefix.",
    });
  });

  test.each([
    ["s3://arn:aws:s3:us-east-1:123456789012:accesspoint/ap", "arn-path", S3_PATH_SENTENCES.arn],
    ["arn:aws:s3-outposts:us-east-1:1:outpost/o/bucket/b", "arn-path", S3_PATH_SENTENCES.arn],
    ["https://sales.s3.amazonaws.com/x", "other-scheme", S3_PATH_SENTENCES.otherScheme],
    ["S3://sales/x", "other-scheme", S3_PATH_SENTENCES.otherScheme],
    ["s3://s3://sales", "other-scheme", S3_PATH_SENTENCES.otherScheme],
    ["s3:///x", "no-bucket", S3_PATH_SENTENCES.noBucket],
  ] as const)("%s is refused as %s", (text, code, message) => {
    expect(readS3Path(text)).toEqual({ ok: false, code, message });
  });
});
