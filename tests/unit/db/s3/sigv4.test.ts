/**
 * The S3 signer's contract with the byte transport's hook: three returned names, the signed headers, the date read at
 * send time, the empty-payload hash, and the canonical query sorted by the signer itself. The SigV4 core it signs
 * with, and the AWS suite vectors, are tested in tests/unit/db/auth/aws/sigv4.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_PAYLOAD_SHA256, signatureV4 } from "@/lib/db/auth/aws/sigv4";
import type { SigningInput } from "@/lib/db/http/node-transport";
import { s3Signer } from "@/lib/db/providers/objectstore/s3/sigv4";

describe("s3Signer", () => {
  const credentials = { accessKeyId: "AKIDTESTKEY", secretAccessKey: "test-secret-key" };
  const input: SigningInput = {
    method: "GET",
    host: "127.0.0.1:9000",
    path: "/sales",
    query: "prefix=a&list-type=2",
    headers: Object.freeze({
      host: "127.0.0.1:9000",
      "accept-encoding": "identity",
      range: "bytes=0-9",
      "x-amz-checksum-mode": "ENABLED",
    }),
    body: "",
  };

  test("lists exactly the three names it returns", () => {
    const signer = s3Signer(credentials, "us-east-1", () => new Date("2026-10-09T13:14:43.000Z"));
    expect(signer.headerNames).toEqual(["authorization", "x-amz-date", "x-amz-content-sha256"]);
    expect(Object.keys(signer.sign(input)).sort()).toEqual(["authorization", "x-amz-content-sha256", "x-amz-date"]);
  });

  test("signs host, range, every x-amz-* header and its own two, never accept-encoding, over the sorted query", () => {
    const signer = s3Signer(credentials, "us-east-1", () => new Date("2026-10-09T13:14:43.000Z"));
    const signed = signer.sign(input);
    expect(signed["x-amz-date"]).toBe("20261009T131443Z");
    expect(signed["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
    const expected = signatureV4(
      {
        method: "GET",
        canonicalUri: "/sales",
        canonicalQuery: "list-type=2&prefix=a",
        headers: {
          host: "127.0.0.1:9000",
          range: "bytes=0-9",
          "x-amz-checksum-mode": "ENABLED",
          "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
          "x-amz-date": "20261009T131443Z",
        },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      credentials,
      { region: "us-east-1", service: "s3", amzDate: "20261009T131443Z" },
    );
    expect(signed.authorization).toBe(expected);
    expect(signed.authorization).toContain(
      "Credential=AKIDTESTKEY/20261009/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date, Signature=",
    );
  });

  test("reads the clock at each sign, never at construction", () => {
    let reads = 0;
    const signer = s3Signer(credentials, "us-east-1", () => {
      reads += 1;
      return new Date(Date.UTC(2026, 9, 9, 13, 14, reads));
    });
    expect(reads).toBe(0);
    expect(signer.sign(input)["x-amz-date"]).toBe("20261009T131401Z");
    expect(signer.sign(input)["x-amz-date"]).toBe("20261009T131402Z");
  });

  test("a query pair with no = throws an Error naming the defect", () => {
    const signer = s3Signer(credentials, "us-east-1", () => new Date(0));
    expect(() => signer.sign({ ...input, query: "versions" })).toThrow(
      'The request query holds a pair with no "=", so it cannot be signed',
    );
  });
});
