/**
 * The SigV4 core and the S3 signer: 24 of 24 AWS suite vectors, the smithy S3-mode vector, and
 * the signer's contract with PR 1's hook: three returned names, the signed headers, the date read at send time, the
 * empty-payload hash, and the canonical query sorted by the signer itself.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rfc3986Path } from "@/lib/db/http/endpoint";
import type { SigningInput } from "@/lib/db/http/node-transport";
import { s3Query } from "@/lib/db/providers/objectstore/s3/encoding";
import {
  amzDateOf,
  type CanonicalRequest,
  canonicalQueryOf,
  EMPTY_PAYLOAD_SHA256,
  s3Signer,
  signatureV4,
} from "@/lib/db/providers/objectstore/s3/sigv4";

interface SuiteVector {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string | null | readonly (string | null)[]>>;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  };
  readonly authorization: string;
}

const suite = JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures/s3/sigv4-suite.json"), "utf8")) as {
  readonly header: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    readonly service: string;
    readonly amzDate: string;
  };
  readonly vectors: readonly SuiteVector[];
};
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function canonicalOf(vector: SuiteVector): CanonicalRequest {
  const pairs = Object.entries(vector.request.query).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one): [string, string] => [name, one ?? ""]),
  );
  return {
    method: vector.request.method,
    canonicalUri: rfc3986Path(vector.request.path.slice(1).split("/")),
    canonicalQuery: s3Query(pairs),
    headers: Object.fromEntries(
      Object.entries(vector.request.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
    ),
    payloadHash: sha256(vector.request.body ?? ""),
  };
}

describe("the AWS SigV4 suite", () => {
  test("holds 24 vectors", () => {
    expect(suite.vectors).toHaveLength(24);
  });

  test.each(suite.vectors.map((vector) => [vector.name, vector]))("%s", (_name, vector) => {
    const { header } = suite;
    expect(
      signatureV4(canonicalOf(vector as SuiteVector), header, {
        region: header.region,
        service: header.service,
        amzDate: header.amzDate,
      }),
    ).toBe((vector as SuiteVector).authorization);
  });
});

test("the smithy S3-mode vector /foo=bar", () => {
  const authorization = signatureV4(
    {
      method: "POST",
      canonicalUri: rfc3986Path(["foo=bar"]),
      canonicalQuery: "",
      headers: {
        host: "foo.us-bar-1.amazonaws.com",
        "x-amz-date": "20000101T000000Z",
        "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    },
    { accessKeyId: "foo", secretAccessKey: "bar" },
    { region: "us-bar-1", service: "foo", amzDate: "20000101T000000Z" },
  );
  expect(authorization.split("Signature=")[1]).toBe("0d859e5a74374efc2c9f14ba9352df14c68e411a1f44bd639fdd024e5f7b7ef1");
});

test("the empty-payload hash is the SHA-256 of nothing", () => {
  expect(EMPTY_PAYLOAD_SHA256).toBe(sha256(""));
});

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

describe("helpers", () => {
  test("amzDateOf writes YYYYMMDDTHHMMSSZ in UTC", () => {
    expect(amzDateOf(new Date("2015-08-30T12:36:00.123Z"))).toBe("20150830T123600Z");
  });

  test("canonicalQueryOf sorts pairs by encoded name then value and keeps the empty query", () => {
    expect(canonicalQueryOf("")).toBe("");
    expect(canonicalQueryOf("prefix=&max-keys=1&list-type=2&a=2&a=1")).toBe("a=1&a=2&list-type=2&max-keys=1&prefix=");
  });
});
