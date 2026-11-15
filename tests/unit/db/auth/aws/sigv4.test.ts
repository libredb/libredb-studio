/**
 * The shared SigV4 core: 24 of 24 AWS suite vectors, the smithy vector, the canonical header order, the empty-payload
 * hash, the two helpers, payloadSha256, the payload hash of a text body, and sigV4Headers, which builds the three
 * headers a signed request carries. The suite stays at tests/fixtures/s3/sigv4-suite.json, where the Secret Scan's
 * pinned entry names it; each vector's canonical query is built with the shared rfc3986Query and compareEncodedPairs.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  amzDateOf,
  type CanonicalRequest,
  canonicalQueryOf,
  compareEncodedPairs,
  EMPTY_PAYLOAD_SHA256,
  payloadSha256,
  signatureV4,
  sigV4Headers,
} from "@/lib/db/auth/aws/sigv4";
import { rfc3986Encode, rfc3986Path, rfc3986Query } from "@/lib/db/http/endpoint";

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

const suite = JSON.parse(readFileSync(join(import.meta.dir, "../../../../fixtures/s3/sigv4-suite.json"), "utf8")) as {
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

/** The pairs in canonical order: sorted by encoded name, then encoded value, then encoded by rfc3986Query. */
function canonicalQuery(pairs: readonly (readonly [string, string])[]): string {
  const encoded = (pair: readonly [string, string]): [string, string] => [
    rfc3986Encode(pair[0]),
    rfc3986Encode(pair[1]),
  ];
  return rfc3986Query([...pairs].sort((a, b) => compareEncodedPairs(encoded(a), encoded(b))));
}

function canonicalOf(vector: SuiteVector): CanonicalRequest {
  const pairs = Object.entries(vector.request.query).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one): [string, string] => [name, one ?? ""]),
  );
  return {
    method: vector.request.method,
    canonicalUri: rfc3986Path(vector.request.path.slice(1).split("/")),
    canonicalQuery: canonicalQuery(pairs),
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

test("the smithy vector /foo=bar", () => {
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

test("signs header names in code-unit order, where a locale order would put a~ before ab", () => {
  const authorization = signatureV4(
    {
      method: "GET",
      canonicalUri: "/",
      canonicalQuery: "",
      headers: { "a~": "2", host: "127.0.0.1:9000", ab: "1" },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    },
    { accessKeyId: "AKIDTESTKEY", secretAccessKey: "test-secret-key" },
    { region: "us-east-1", service: "s3", amzDate: "20261009T131443Z" },
  );
  expect(["ab", "a~"].sort((a, b) => a.localeCompare(b))).toEqual(["a~", "ab"]);
  expect(authorization).toContain("SignedHeaders=ab;a~;host, Signature=");
});

test("the empty-payload hash is the SHA-256 of nothing", () => {
  expect(EMPTY_PAYLOAD_SHA256).toBe(sha256(""));
});

describe("helpers", () => {
  test("amzDateOf writes YYYYMMDDTHHMMSSZ in UTC", () => {
    expect(amzDateOf(new Date("2015-08-30T12:36:00.123Z"))).toBe("20150830T123600Z");
  });

  test("compareEncodedPairs orders by code unit, name first, and an equal pair is 0", () => {
    expect(compareEncodedPairs(["B", "1"], ["a", "0"])).toBe(-1);
    expect(compareEncodedPairs(["a", "1"], ["a", "0"])).toBe(1);
    expect(compareEncodedPairs(["a", "1"], ["a", "1"])).toBe(0);
  });

  test("canonicalQueryOf sorts pairs by encoded name then value and keeps the empty query", () => {
    expect(canonicalQueryOf("")).toBe("");
    expect(canonicalQueryOf("prefix=&max-keys=1&list-type=2&a=2&a=1")).toBe("a=1&a=2&list-type=2&max-keys=1&prefix=");
  });

  test("canonicalQueryOf throws an Error naming a pair with no =", () => {
    expect(() => canonicalQueryOf("a=1&versions")).toThrow(
      'The request query holds a pair with no "=", so it cannot be signed',
    );
  });
});

describe("payloadSha256", () => {
  test("is the hex SHA-256 of the UTF-8 text, and of nothing the empty-payload hash", () => {
    expect(payloadSha256("")).toBe(EMPTY_PAYLOAD_SHA256);
    expect(payloadSha256("Param1=value1")).toBe(sha256("Param1=value1"));
    // U+00E9 is the two UTF-8 bytes C3 A9, never the one Latin-1 byte E9.
    expect(payloadSha256("\u00e9")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
  });
});

describe("sigV4Headers", () => {
  const { header } = suite;
  const vector = (name: string): SuiteVector => {
    const found = suite.vectors.find((one) => one.name === name);
    if (found === undefined) throw new Error(`no vector ${name}`);
    return found;
  };
  const scope = { region: header.region, service: header.service };
  const now = new Date("2015-08-30T12:36:00Z");
  const keys = { accessKeyId: header.accessKeyId, secretAccessKey: header.secretAccessKey };
  const root = { method: "POST", host: "example.amazonaws.com", canonicalUri: "/", canonicalQuery: "" };

  test("without a session token: authorization and x-amz-date, signing host and x-amz-date (post-vanilla)", () => {
    const headers = sigV4Headers({ ...root, signed: {}, payloadHash: EMPTY_PAYLOAD_SHA256 }, keys, scope, now);
    expect(headers).toEqual({ authorization: vector("post-vanilla").authorization, "x-amz-date": header.amzDate });
  });

  test("with a session token: x-amz-security-token is sent and signed (post-sts-header-before)", () => {
    const sts = vector("post-sts-header-before");
    const sessionToken = sts.request.headers["x-amz-security-token"];
    const headers = sigV4Headers(
      { ...root, signed: {}, payloadHash: EMPTY_PAYLOAD_SHA256 },
      { ...keys, sessionToken },
      scope,
      now,
    );
    expect(headers).toEqual({
      authorization: sts.authorization,
      "x-amz-date": header.amzDate,
      "x-amz-security-token": sessionToken,
    });
  });

  test("signs the given headers and the caller's payload hash, and returns none of them (post-x-www-form-urlencoded)", () => {
    const form = vector("post-x-www-form-urlencoded");
    const headers = sigV4Headers(
      {
        ...root,
        signed: { "content-type": "application/x-www-form-urlencoded" },
        payloadHash: payloadSha256(form.request.body ?? ""),
      },
      keys,
      scope,
      now,
    );
    expect(headers).toEqual({ authorization: form.authorization, "x-amz-date": header.amzDate });
  });

  test("signs the canonical query it is given (post-vanilla-query)", () => {
    const headers = sigV4Headers(
      { ...root, canonicalQuery: "Param1=value1", signed: {}, payloadHash: EMPTY_PAYLOAD_SHA256 },
      keys,
      scope,
      now,
    );
    expect(headers.authorization).toBe(vector("post-vanilla-query").authorization);
  });

  test.each(["host", "x-amz-date", "x-amz-security-token"])("refuses a given header named %s", (name) => {
    expect(() =>
      sigV4Headers({ ...root, signed: { [name]: "x" }, payloadHash: EMPTY_PAYLOAD_SHA256 }, keys, scope, now),
    ).toThrow(`The signed headers name ${name}, which the signature sets itself`);
  });
});
