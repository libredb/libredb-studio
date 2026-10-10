/**
 * What an S3 command is to the confirmation gate: no operation asks, because v1 only reads;
 * the refusal is the parser's own sentence with the browser's empty context; the reader classifies an accepted text
 * by its command kind.
 */
import { describe, expect, test } from "bun:test";
import { parseS3Command } from "@/lib/db/providers/objectstore/s3/console/commands";
import {
  readS3Operations,
  S3_DESTRUCTIVE_OPERATIONS,
  s3Refusal,
} from "@/lib/db/providers/objectstore/s3/console/guard";

describe("the S3 vocabulary row's three members", () => {
  test("no operation is destructive, so the gate never asks", () => {
    expect(S3_DESTRUCTIVE_OPERATIONS.size).toBe(0);
  });

  test("s3Refusal answers the parser's sentence for a refused text and undefined for an accepted one", () => {
    for (const text of ["aws s3 rm s3://b/k", "aws s3api get-object-attributes --bucket b --key k", "aws ec2 x", ""]) {
      const parsed = parseS3Command(text, {});
      expect(parsed.ok).toBe(false);
      expect(s3Refusal(text)).toBe(parsed.ok ? undefined : parsed.refusal.message);
    }
    expect(s3Refusal("aws s3 ls s3://sales/2026/")).toBeUndefined();
  });

  test.each([
    ["aws s3 ls", "ls"],
    ["aws s3 ls s3://sales/", "ls"],
    ["aws s3api list-buckets", "list-buckets"],
    ["aws s3api list-objects-v2 --bucket b", "list-objects-v2"],
    ["aws s3api list-object-versions --bucket b", "list-object-versions"],
    ["aws s3api head-bucket --bucket b", "head-bucket"],
    ["aws s3api head-object --bucket b --key k", "head-object"],
    ["aws s3api get-object-tagging --bucket b --key k", "get-object-tagging"],
    ["aws s3api get-bucket-location --bucket b", "get-bucket-location"],
    ["aws s3api get-bucket-versioning --bucket b", "get-bucket-versioning"],
    ["preview s3://b/k", "preview"],
  ])("readS3Operations(%j) is [%s]", (text, kind) => {
    expect(readS3Operations(text)).toEqual([kind]);
  });

  test("readS3Operations answers undefined for a refused text", () => {
    expect(readS3Operations("aws s3 cp a s3://b/a")).toBeUndefined();
  });

  test("the browser accepts a --region only the server can check, and the server refuses it", () => {
    expect(s3Refusal("aws s3 ls --region eu-west-1")).toBeUndefined();
    expect(parseS3Command("aws s3 ls --region eu-west-1", { region: "us-east-1" }).ok).toBe(false);
  });
});
