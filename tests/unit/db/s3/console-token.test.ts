/**
 * The AWS CLI's NextToken for ListObjectsV2: standard base64 with padding of the JSON object
 * {"ContinuationToken": <token>}, optionally with boto_truncate_amount. Studio writes the compact form and reads any
 * valid JSON, so a token resumes in either tool. The vectors are two recorded runs of
 * the CLI's own encoder.
 */
import { describe, expect, test } from "bun:test";
import { decodeS3StartingToken, encodeS3StartingToken } from "@/lib/db/providers/objectstore/s3/console/token";

/** The JSON a token holds, read back by base64 and JSON.parse as the CLI reads it. */
function jsonOf(token: string): unknown {
  const binary = atob(token);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
}

const MINIO_TOKEN = "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=";

/** Tokens the AWS CLI wrote, and the service token each carries. */
const CLI_VECTORS: readonly (readonly [string, string, number | undefined])[] = [
  [
    "eyJDb250aW51YXRpb25Ub2tlbiI6ICIxdWVHY3hMUFJ4MVRyL1hZRXhIbmhiWUxndmVEczJKL3dtMzZIeTR2Yk93TT0ifQ==",
    MINIO_TOKEN,
    undefined,
  ],
  [
    "eyJDb250aW51YXRpb25Ub2tlbiI6ICIxdWVHY3hMUFJ4MVRyL1hZRXhIbmhiWUxndmVEczJKL3dtMzZIeTR2Yk93TT0iLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAyfQ==",
    MINIO_TOKEN,
    2,
  ],
  ["eyJDb250aW51YXRpb25Ub2tlbiI6ICJhYmMifQ==", "abc", undefined],
  ["eyJDb250aW51YXRpb25Ub2tlbiI6ICJhXHUwMDdmYiJ9", "a\u007fb", undefined],
  ["eyJDb250aW51YXRpb25Ub2tlbiI6ICJcdTAwZTlcdWQ4M2RcdWRlMDAifQ==", "\u00e9\ud83d\ude00", undefined],
  ["eyJDb250aW51YXRpb25Ub2tlbiI6ICJ4XG55XHUwMDAxLyJ9", "x\ny\u0001/", undefined],
];

describe("encodeS3StartingToken", () => {
  test("writes the compact JSON object in standard base64 with padding", () => {
    expect(encodeS3StartingToken("abc")).toBe("eyJDb250aW51YXRpb25Ub2tlbiI6ImFiYyJ9");
  });

  test.each(CLI_VECTORS.map(([, token]) => [token]))(
    "a token Studio writes for %j decodes to {ContinuationToken}",
    (token) => {
      const written = encodeS3StartingToken(token);
      expect(jsonOf(written)).toEqual({ ContinuationToken: token });
      expect(decodeS3StartingToken(written)).toEqual({ continuationToken: token });
    },
  );
});

describe("decodeS3StartingToken", () => {
  test.each(CLI_VECTORS)("the CLI's %s resumes in Studio", (text, token, amount) => {
    expect(decodeS3StartingToken(text)).toEqual(
      amount === undefined ? { continuationToken: token } : { continuationToken: token, truncateAmount: amount },
    );
  });

  test("a truncate amount from 0 to 1,000 is read", () => {
    expect(decodeS3StartingToken(btoa('{"ContinuationToken":"a","boto_truncate_amount":0}'))).toEqual({
      continuationToken: "a",
      truncateAmount: 0,
    });
    expect(decodeS3StartingToken(btoa('{"ContinuationToken":"a","boto_truncate_amount":1000}'))).toEqual({
      continuationToken: "a",
      truncateAmount: 1000,
    });
  });

  test.each([
    ["the empty text", ""],
    ["8,193 characters", "A".repeat(8_193)],
    ["text that is not base64", "not a token!"],
    ["the AWS CLI's legacy ___ form", "abc___2"],
    ["unpadded base64", "eyJDb250aW51YXRpb25Ub2tlbiI6ImFiYyJ"],
    ["bytes that are not UTF-8", btoa("\xff")],
    ["text that is not JSON", btoa('{"ContinuationToken":"a"')],
    ["JSON that is not an object", btoa('["a"]')],
    ["JSON null", btoa("null")],
    ["a JSON string", btoa('"a"')],
    ["boto_encoded_keys", btoa('{"ContinuationToken":"a","boto_encoded_keys":[["Marker"]]}')],
    [
      "a list-object-versions token (the CLI's KeyMarker vector)",
      "eyJLZXlNYXJrZXIiOiAiYS50eHQiLCAiVmVyc2lvbklkTWFya2VyIjogIm51bGwifQ==",
    ],
    ["an extra key", btoa('{"ContinuationToken":"a","Other":1}')],
    ["a __proto__ key", btoa('{"ContinuationToken":"a","__proto__":1}')],
    ["no ContinuationToken", btoa('{"boto_truncate_amount":1}')],
    ["an empty ContinuationToken", btoa('{"ContinuationToken":""}')],
    ["a ContinuationToken that is not a string", btoa('{"ContinuationToken":1}')],
    ["a negative truncate amount", btoa('{"ContinuationToken":"a","boto_truncate_amount":-1}')],
    ["a fractional truncate amount", btoa('{"ContinuationToken":"a","boto_truncate_amount":1.5}')],
    ["a truncate amount over 1,000", btoa('{"ContinuationToken":"a","boto_truncate_amount":1001}')],
    ["a truncate amount written as a string", btoa('{"ContinuationToken":"a","boto_truncate_amount":"2"}')],
  ])("refuses %s", (_name, text) => {
    expect(decodeS3StartingToken(text)).toBeUndefined();
  });

  test("a token wrapping the longest service token the client reads stays inside the bound", () => {
    const written = encodeS3StartingToken("t".repeat(4_096));
    expect(written.length).toBeLessThanOrEqual(8_192);
    expect(decodeS3StartingToken(written)).toEqual({ continuationToken: "t".repeat(4_096) });
  });
});
