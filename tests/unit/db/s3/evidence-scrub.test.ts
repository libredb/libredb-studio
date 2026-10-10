/**
 * The scrub every S3 capture passes before tests/live/s3-evidence.ts writes it: the
 * signature never reaches a file, dates are kept, request ids become a placeholder, only the headers the provider
 * asks for are kept, continuation tokens are kept byte for byte, an exchange body over 512 KiB is refused, and
 * nothing is written while a fixture secret appears in any encoding, binary bodies decoded first.
 */
import { describe, expect, test } from "bun:test";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import {
  maskSecrets,
  normalizeMessage,
  REQUEST_ID_PLACEHOLDER,
  S3_EXCHANGE_BODY_MAX_BYTES,
  type S3FixtureSecret,
  scrubCapture,
  secretEncodings,
  secretHits,
} from "../../../helpers/s3-evidence-scrub";
import type { S3Capture, S3Exchange } from "../../../helpers/s3-wire";

const SECRETS: readonly S3FixtureSecret[] = [
  { label: "root password", value: "Probe123pass!" },
  { label: "garage rw secret", value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
];

function exchange(overrides: Partial<S3Exchange> = {}): S3Exchange {
  return {
    step: "list",
    request: {
      method: "GET",
      path: "/studio-bulk",
      query: "continuation-token=1%2Fabc%3D%3D&list-type=2",
      headers: { host: "127.0.0.1:9010", "x-amz-date": "20261009T141900Z", "x-amz-content-sha256": "e3b0" },
      authorization: {
        scheme: "AWS4-HMAC-SHA256",
        credential: "libredb/20261009/us-east-1/s3/aws4_request",
        signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"],
      },
    },
    answer: {
      status: 200,
      headers: [
        ["date", "Fri, 09 Oct 2026 14:19:00 GMT"],
        ["x-amz-request-id", "186C2A1F9B3E5D00"],
        ["x-request-id", "rustfs-7f1c"],
        ["x-minio-error-desc", '"a description"'],
        ["server", "MinIO"],
        ["x-amz-meta-project", "libredb"],
      ],
      headersTruncated: false,
      contentType: "application/xml",
      contentEncoding: null,
      retryAfter: null,
      truncated: false,
      body: { text: "<ListBucketResult><NextContinuationToken>1/abc==</NextContinuationToken></ListBucketResult>" },
    },
    ...overrides,
  };
}

function capture(exchanges: S3Exchange[], result: unknown = { ok: true }): S3Capture {
  return { file: "silo-2026-10-09-x/A21.json", scenario: "A21", target: "silo", clockOffsetMs: 0, exchanges, result };
}

describe("scrubCapture", () => {
  test("keeps the dates, the credential scope and the continuation tokens, and writes no signature", () => {
    const text = scrubCapture(capture([exchange()]), SECRETS);
    const written = JSON.parse(text) as S3Capture;
    const [first] = written.exchanges;
    expect(first.request.headers["x-amz-date"]).toBe("20261009T141900Z");
    expect(first.request.authorization?.credential).toBe("libredb/20261009/us-east-1/s3/aws4_request");
    expect(first.request.query).toBe("continuation-token=1%2Fabc%3D%3D&list-type=2");
    expect(first.answer.body).toEqual({
      text: "<ListBucketResult><NextContinuationToken>1/abc==</NextContinuationToken></ListBucketResult>",
    });
    expect(first.answer.headers).toContainEqual(["date", "Fri, 09 Oct 2026 14:19:00 GMT"]);
    expect(text).not.toContain("Signature=");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("request ids become the placeholder, and a header the provider does not ask for is not written", () => {
    const written = JSON.parse(scrubCapture(capture([exchange()]), SECRETS)) as S3Capture;
    const headers = written.exchanges[0].answer.headers;
    expect(headers).toContainEqual(["x-amz-request-id", REQUEST_ID_PLACEHOLDER]);
    expect(headers).toContainEqual(["x-request-id", REQUEST_ID_PLACEHOLDER]);
    expect(headers).toContainEqual(["x-amz-meta-project", "libredb"]);
    expect(headers.map(([name]) => name)).not.toContain("x-minio-error-desc");
    expect(headers.map(([name]) => name)).not.toContain("server");
    for (const [name] of headers)
      expect(
        S3_RESPONSE_HEADERS.names.includes(name) ||
          (S3_RESPONSE_HEADERS.prefixes ?? []).some((prefix) => name.startsWith(prefix)),
      ).toBe(true);
  });

  test("each fixture secret is refused in each encoding, naming the label and the encoding and never the value", () => {
    for (const secret of SECRETS)
      for (const { encoding, text } of secretEncodings(secret.value)) {
        const leaked = capture([
          exchange({ answer: { ...exchange().answer, body: { text: `<Message>${text}</Message>` } } }),
        ]);
        let message = "";
        try {
          scrubCapture(leaked, SECRETS);
        } catch (error) {
          message = (error as Error).message;
        }
        expect({ encoding, named: message.includes(`${secret.label} ${encoding}`) }).toEqual({ encoding, named: true });
        expect(message).not.toContain(secret.value);
      }
  });

  test("a secret inside a binary body is found at any offset, because base64 bodies are decoded before the search", () => {
    const bytes = new Uint8Array([0xff, ...new TextEncoder().encode("Probe123pass!"), 0xfe]);
    const base64 = Buffer.from(bytes).toString("base64");
    expect(base64.includes(Buffer.from("Probe123pass!").toString("base64"))).toBe(false);
    expect(() =>
      scrubCapture(capture([exchange({ answer: { ...exchange().answer, body: { base64 } } })]), SECRETS),
    ).toThrow("root password raw");
  });

  test("a secret in the recorded result is refused too", () => {
    expect(() => scrubCapture(capture([exchange()], { refused: "Probe123pass! was sent" }), SECRETS)).toThrow(
      "root password raw",
    );
  });

  test("an exchange body over 512 KiB is refused", () => {
    const big = { text: "a".repeat(S3_EXCHANGE_BODY_MAX_BYTES + 1) };
    expect(() => scrubCapture(capture([exchange({ answer: { ...exchange().answer, body: big } })]), SECRETS)).toThrow(
      "silo-2026-10-09-x/A21.json step list: the answer body holds 524289 bytes, over 512 KiB",
    );
  });
});

describe("secretHits and normalizeMessage", () => {
  test("secretHits names the label and the encoding of every hit", () => {
    expect(secretHits("x Probe123pass%21 y", SECRETS)).toEqual(["root password percent-encoded"]);
    expect(secretHits("nothing here", SECRETS)).toEqual([]);
  });

  test("secretHits finds a secret escaped in an XML body", () => {
    expect(secretEncodings("a&b<c>\"d'").map((e) => e.encoding)).toContain("XML-escaped");
    expect(
      secretHits("<Message>a&amp;b&lt;c&gt;&quot;d&apos;</Message>", [{ label: "xml secret", value: "a&b<c>\"d'" }]),
    ).toEqual(["xml secret XML-escaped"]);
  });

  test("secretHits finds a secret escaped with XML numeric references, as Go's encoding/xml writes it", () => {
    const secret = { label: "quoted secret", value: "Fixture'Quote\"123" };
    expect(secretHits("<Message>Fixture&#39;Quote&#34;123</Message>", [secret])).toEqual([
      "quoted secret XML-escaped with numeric references",
    ]);
    expect(
      secretHits("<Message>a&amp;b&lt;c&gt;&#34;d&#39;</Message>", [{ label: "xml secret", value: "a&b<c>\"d'" }]),
    ).toEqual(["xml secret XML-escaped with numeric references"]);
  });

  test("secretHits finds the base64 and base64url of a secret at each of the three byte offsets inside a longer value", () => {
    // A secret whose base64 at every offset holds + or /, so each base64url core is a spelling of its own.
    const secret = { label: "offset secret", value: "Fixture?>~Pass?>~123" };
    for (const [offset, prefix] of ["", "x", "xy"].entries()) {
      const bytes = Buffer.from(`${prefix}${secret.value}~~`, "utf8");
      for (const [encoding, text] of [
        ["base64", bytes.toString("base64")],
        ["base64url", bytes.toString("base64url")],
      ] as const)
        expect({ offset, encoding, hits: secretHits(`<Body>${text}</Body>`, [secret]) }).toEqual({
          offset,
          encoding,
          hits: [`offset secret ${encoding} core at byte offset ${offset}`],
        });
    }
  });

  test("base64url of one byte and then a secret is found", () => {
    expect(secretHits(Buffer.from(`x${SECRETS[0].value}`).toString("base64url"), SECRETS)).toEqual([
      "root password base64 core at byte offset 1",
    ]);
  });

  test("normalizeMessage drops the request id clause and leaves a message without one unchanged", () => {
    expect(normalizeMessage("S3 answered 500 InternalError (request id 186C2A1F9B3E5D00).")).toBe(
      "S3 answered 500 InternalError.",
    );
    expect(normalizeMessage("no clause here")).toBe("no clause here");
  });
});

describe("maskSecrets", () => {
  test("a FAIL line holding the percent-encoded and the base64 spelling of a secret prints <secret> for both", () => {
    const secret = SECRETS[0];
    const percent = secretEncodings(secret.value).find((e) => e.encoding === "percent-encoded")?.text;
    const base64 = Buffer.from(secret.value).toString("base64");
    const line = `FAIL A65 list: sent ${percent} and answered ${base64}`;
    expect(maskSecrets(line, SECRETS)).toBe("FAIL A65 list: sent <secret> and answered <secret>");
  });

  test("every spelling of every secret is masked, and a line without one is unchanged", () => {
    for (const secret of SECRETS)
      for (const { encoding, text } of secretEncodings(secret.value)) {
        const masked = maskSecrets(`FAIL x: ${text}.`, SECRETS);
        expect({ encoding, hits: secretHits(masked, SECRETS) }).toEqual({ encoding, hits: [] });
        expect(masked).toContain("<secret>");
      }
    expect(maskSecrets("PASS A1 list (12 ms)", SECRETS)).toBe("PASS A1 list (12 ms)");
  });
});
