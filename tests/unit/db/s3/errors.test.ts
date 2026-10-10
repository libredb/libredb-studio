/**
 * The error mapping: one case per row E0a to E34 and per measured server difference, built from
 * the statuses, codes and messages measured on MinIO, Silo, Garage and RustFS. Classification reads the raw
 * values; only a quoted value passes `serverText`, and no raw server value is stored on the thrown error.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { S3ClientContext, S3Operation } from "@/lib/db/providers/objectstore/s3/client";
import {
  S3_BUCKET_LIST_RESPONSE_BYTES,
  S3_HEAD_RESPONSE_BYTES,
  S3_LIST_RESPONSE_BYTES,
  S3_SMALL_RESPONSE_BYTES,
} from "@/lib/db/providers/objectstore/s3/constants";
import {
  fieldsOf,
  noteRequestNames,
  S3_ERROR_SENTENCES,
  S3_VERBS,
  S3ServerError,
  type S3ServerErrorFields,
  toProviderError,
} from "@/lib/db/providers/objectstore/s3/errors";
import { DuplicateRunError, LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { secretForms } from "@/lib/db/utils/server-text";

const NOW = new Date("2026-10-09T13:14:43.000Z");
const SIGNED: S3ClientContext = {
  region: "us-east-1",
  signs: true,
  clock: () => NOW,
  secretForms: secretForms(["test-secret-key", "AKIDTESTKEY"]),
  endpointText: "http://localhost:9000",
};
const UNSIGNED: S3ClientContext = { ...SIGNED, signs: false, secretForms: [] };
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

function server(fields: Partial<S3ServerErrorFields> & { readonly status: number }): S3ServerError {
  return new S3ServerError({ operation: "ListObjectsV2", method: "GET", bucket: "sales", ...fields });
}

function mapped(error: unknown, operation: S3Operation = "ListObjectsV2", context = SIGNED, details = {}): Error {
  return toProviderError(error, operation, context, details) as Error;
}

function expectRow(error: Error, kind: new (...args: never[]) => Error, message: string): void {
  expect(error).toBeInstanceOf(kind);
  expect(error.message).toBe(message);
  expect((error as { provider?: string }).provider).toBe("s3");
}

const LIST = 'list bucket "sales"';
const READ = 'read object "a.csv" in bucket "sales"';

describe("E0: failures that are not answers", () => {
  test("E0a: a DatabaseError other than a TransportError passes as the same instance", () => {
    const passing = [
      new DatabaseConfigError("refused", "s3"),
      new LimiterFullError("full"),
      new DuplicateRunError("duplicate"),
      new QueryCancelledError("The query was cancelled."),
    ];
    for (const error of passing) expect(toProviderError(error, "ListBuckets", SIGNED)).toBe(error);
    const transport = new TransportError("network", "The request failed");
    expect(toProviderError(transport, "ListBuckets", SIGNED)).not.toBe(transport);
  });

  test("E0b: a permit wait the deadline ended is E1's sentence, with the operation's names", () => {
    const wait = new DOMException("The operation timed out.", "TimeoutError");
    noteRequestNames(wait, { bucket: "sales" });
    expectRow(
      mapped(wait, "ListObjectsV2", SIGNED, { timeoutMs: 10_000 }),
      TimeoutError,
      `The S3 server at http://localhost:9000 did not answer ${LIST} within 10 seconds; nothing was retried.`,
    );
  });

  test("E0c: any other rejection after the session's lifetime ended is E3's sentence", () => {
    const lifetime = new AbortController();
    lifetime.abort();
    expectRow(
      mapped(new DOMException("aborted", "AbortError"), "ListBuckets", SIGNED, { lifetime: lifetime.signal }),
      ConnectionError,
      "The connection was closed while a request to the S3 server was in flight.",
    );
  });

  test("E0d: a defect is rethrown as the same value, never reworded", () => {
    const defect = new Error('The request query holds a pair with no "=", so it cannot be signed');
    expect(toProviderError(defect, "ListBuckets", SIGNED)).toBe(defect);
    expect(toProviderError("text", "ListBuckets", SIGNED)).toBe("text");
  });
});

describe("E1 to E7: transport failures", () => {
  const named = (error: TransportError, capBytes = S3_LIST_RESPONSE_BYTES) => {
    noteRequestNames(error, { bucket: "sales", capBytes });
    return error;
  };

  test("E1: a timeout names the deadline in seconds", () => {
    expectRow(
      mapped(
        named(new TransportError("timeout", "The request did not finish within its time limit")),
        "ListObjectsV2",
        SIGNED,
        { timeoutMs: 2_500 },
      ),
      TimeoutError,
      `The S3 server at http://localhost:9000 did not answer ${LIST} within 2.5 seconds; nothing was retried.`,
    );
  });

  test("E2: an abort after a cancel is the registry's QueryCancelledError, unchanged", () => {
    const run = new AbortController();
    const cancelled = new QueryCancelledError("The query was cancelled.");
    run.abort(cancelled);
    expect(
      toProviderError(named(new TransportError("aborted", "The request was cancelled")), "ListObjectsV2", SIGNED, {
        signal: run.signal,
      }),
    ).toBe(cancelled);
  });

  test("E3: an abort after disconnect", () => {
    const lifetime = new AbortController();
    lifetime.abort();
    expectRow(
      mapped(named(new TransportError("aborted", "The request was cancelled")), "ListObjectsV2", SIGNED, {
        lifetime: lifetime.signal,
      }),
      ConnectionError,
      "The connection was closed while a request to the S3 server was in flight.",
    );
  });

  test("an abort with neither a cancel nor a closed session is a defect, passed on as the same value", () => {
    const run = new AbortController();
    run.abort(new Error("other"));
    const aborted = named(new TransportError("aborted", "The request was cancelled"));
    expect(
      toProviderError(aborted, "ListObjectsV2", SIGNED, {
        signal: run.signal,
        lifetime: new AbortController().signal,
      }),
    ).toBe(aborted);
    expect(toProviderError(aborted, "ListObjectsV2", SIGNED)).toBe(aborted);
  });

  test("E4: an answer over its cap, and the ListBuckets sentence", () => {
    expectRow(
      mapped(named(new TransportError("too-large", "too large"))),
      QueryError,
      `The server's answer to ${LIST} passed 8 MiB, the most Studio reads for it, so it was dropped; narrow the prefix.`,
    );
    expectRow(
      mapped(named(new TransportError("too-large", "too large"), S3_BUCKET_LIST_RESPONSE_BYTES), "ListBuckets"),
      QueryError,
      "The server's list of buckets passed 4 MiB, the most Studio reads for it: set Bucket on the connection to read one bucket without listing them.",
    );
  });

  test("E4: a cap that is not a whole number of MiB is worded in KiB, in bytes, or as one byte", () => {
    const tooLarge = (capBytes: number) => {
      const error = new TransportError("too-large", "too large");
      noteRequestNames(error, { bucket: "sales", key: "a.csv", capBytes });
      return mapped(error, "GetObject").message;
    };
    expect(tooLarge(S3_SMALL_RESPONSE_BYTES)).toContain("passed 64 KiB, the most Studio reads for it");
    expect(tooLarge(1_500)).toContain("passed 1,500 bytes, the most Studio reads for it");
    expect(tooLarge(S3_HEAD_RESPONSE_BYTES)).toContain("passed 1 byte, the most Studio reads for it");
  });

  test("E5: a redirect naming another valid region", () => {
    const redirect = new TransportError("redirect", "redirected", {
      redirect: { status: 301, headers: [["x-amz-bucket-region", "eu-west-1"]], headersTruncated: false },
    });
    expectRow(
      mapped(named(redirect)),
      DatabaseConfigError,
      "This bucket is in region eu-west-1, and this connection signs for us-east-1: set Region to eu-west-1.",
    );
  });

  test("E6: any other redirect", () => {
    const redirect = new TransportError("redirect", "redirected", {
      redirect: { status: 307, headers: [], headersTruncated: false },
    });
    expectRow(
      mapped(named(redirect)),
      ConnectionError,
      `The endpoint answered ${LIST} with a redirect (HTTP 307), which Studio does not follow. Check that Host and Port name the S3 API, not a web console: MinIO and RustFS serve their consoles on another port. An AWS bucket in another region answers this way when the server does not name the region: set Region to the bucket's region.`,
    );
  });

  test("E7: TLS and network failures carry the transport's own message", () => {
    expectRow(
      mapped(named(new TransportError("network", "The request failed (ECONNREFUSED)"))),
      ConnectionError,
      "Could not reach the S3 server at http://localhost:9000: The request failed (ECONNREFUSED)",
    );
    expectRow(
      mapped(named(new TransportError("tls", "The TLS connection failed (CERT_HAS_EXPIRED)"))),
      ConnectionError,
      "Could not reach the S3 server at http://localhost:9000: The TLS connection failed (CERT_HAS_EXPIRED)",
    );
  });
});

describe("E7b to E34: server answers", () => {
  test("E7b: a compressed XML answer, the encoding quoted only when it is a token", () => {
    expectRow(
      mapped(server({ status: 200, problem: { kind: "compressed", contentEncoding: "gzip" } })),
      QueryError,
      `The server answered ${LIST} with a compressed body (gzip), which Studio does not decode: turn off compression in front of the S3 API.`,
    );
    expect(mapped(server({ status: 200, problem: { kind: "compressed", contentEncoding: "x y" } })).message).toContain(
      "(an unnamed encoding)",
    );
  });

  test("E8: an unsigned header refused", () => {
    const sentence =
      "The server refused a request header Studio did not sign. This is a defect in Studio; report it with the server's name and version.";
    expectRow(
      mapped(
        server({
          status: 400,
          code: "AccessDenied",
          message: "There were headers present in the request which were not signed",
        }),
      ),
      QueryError,
      sentence,
    );
    expectRow(
      mapped(
        server({
          status: 400,
          code: "InvalidRequest",
          message: "Missing required header for this request: X-Amz-Content-Sha256",
        }),
      ),
      QueryError,
      sentence,
    );
  });

  test("E9: Garage's wrong region names the expected region; a HEAD's region header does too", () => {
    const sentence =
      "This server expects requests signed for region garage-probe, and this connection signs for us-east-1: set Region to garage-probe.";
    expectRow(
      mapped(
        server({
          status: 400,
          code: "AuthorizationHeaderMalformed",
          message:
            "Authorization header malformed, unexpected scope: '20261009/us-east-1/s3/aws4_request', expected: '20261009/garage-probe/s3/aws4_request'",
          region: "garage-probe",
        }),
      ),
      DatabaseConfigError,
      sentence,
    );
    expectRow(
      mapped(
        server({ status: 400, method: "HEAD", operation: "HeadBucket", bucketRegion: "garage-probe" }),
        "HeadBucket",
      ),
      DatabaseConfigError,
      sentence,
    );
  });

  test("E9 is claimed only on a signed connection; unsigned it is E10", () => {
    const error = server({
      status: 400,
      code: "AuthorizationHeaderMalformed",
      message: "bad scope",
      region: "garage-probe",
    });
    expect(mapped(error, "ListObjectsV2", UNSIGNED).message).toBe(
      "The server refused this connection's signing scope (region us-east-1): check Region. The server said: bad scope",
    );
  });

  test("E10: a malformed scope naming the connection's own region, or an invalid region", () => {
    const sentence =
      "The server refused this connection's signing scope (region us-east-1): check Region. The server said: bad scope";
    expectRow(
      mapped(server({ status: 400, code: "AuthorizationHeaderMalformed", message: "bad scope", region: "us-east-1" })),
      DatabaseConfigError,
      sentence,
    );
    expectRow(
      mapped(server({ status: 400, code: "AuthorizationHeaderMalformed", message: "bad scope", region: "eu west" })),
      DatabaseConfigError,
      sentence,
    );
  });

  test("E12: a wrong secret on MinIO, Silo and RustFS, and on Garage", () => {
    const sentence =
      "The server refused the request signature: check Secret access key. A proxy between Studio and the server that changes the Host header or the request path causes the same refusal.";
    expectRow(
      mapped(
        server({
          status: 403,
          code: "SignatureDoesNotMatch",
          message: "The request signature we calculated does not match",
        }),
      ),
      AuthenticationError,
      sentence,
    );
    expectRow(
      mapped(server({ status: 403, code: "AccessDenied", message: "Forbidden: Invalid signature" })),
      AuthenticationError,
      sentence,
    );
  });

  test("E13: an unknown key, Garage's message holding the ID included, and no raw text on the error", () => {
    const sentence = "The server does not know this access key ID: check Access key ID.";
    const garage = { ...SIGNED, secretForms: secretForms(["test-secret-key", "GKtest"]) };
    const error = mapped(
      server({ status: 403, code: "AccessDenied", message: "Forbidden: No such key: GKtest", region: "garage-probe" }),
      "ListObjectsV2",
      garage,
    );
    expectRow(error, AuthenticationError, sentence);
    expect(JSON.stringify(error)).not.toContain("GKtest");
    expectRow(
      mapped(server({ status: 403, code: "InvalidAccessKeyId", bucketRegion: "eu-central-1" })),
      AuthenticationError,
      sentence,
    );
  });

  test("E14: skew by code, by Garage's message, or by a bare 403's date header", () => {
    const twentyMinutes = new Date(NOW.getTime() - 20 * 60_000).toUTCString();
    const measured =
      "This machine's clock and the server's differ by about 20 minutes, more than the server accepts: correct the clock on this machine or on the server.";
    const unmeasured =
      "This machine's clock and the server's differ by more than the server accepts: correct the clock on this machine or on the server.";
    expectRow(
      mapped(server({ status: 403, code: "RequestTimeTooSkewed", serverDate: twentyMinutes })),
      AuthenticationError,
      measured,
    );
    expectRow(
      mapped(server({ status: 403, code: "InvalidRequest", message: "Date is too old" })),
      AuthenticationError,
      unmeasured,
    );
    // Garage v2.4.1 prefixes the message, measured on the fixture with the clock 25 hours behind.
    expectRow(
      mapped(server({ status: 400, code: "InvalidRequest", message: "Bad request: Date is too old" })),
      AuthenticationError,
      unmeasured,
    );
    expect(
      mapped(server({ status: 400, code: "InvalidRequest", message: "Bad request: Date is too old to read" })).message,
    ).not.toBe(unmeasured);
    expectRow(
      mapped(
        server({ status: 403, method: "HEAD", operation: "HeadObject", key: "a.csv", serverDate: twentyMinutes }),
        "HeadObject",
      ),
      AuthenticationError,
      measured,
    );
  });

  test("a bare 403 whose date is inside the window is E20, not E14", () => {
    const fiveMinutes = new Date(NOW.getTime() - 5 * 60_000).toUTCString();
    expect(mapped(server({ status: 403, serverDate: fiveMinutes }))).toBeInstanceOf(QueryError);
  });

  test("E15: Garage refuses anonymous access", () => {
    expectRow(
      mapped(
        server({
          status: 403,
          code: "AccessDenied",
          message: "Forbidden: Garage does not support anonymous access yet",
        }),
        "ListObjectsV2",
        UNSIGNED,
      ),
      AuthenticationError,
      "This server takes no unsigned requests: fill in Access key ID and Secret access key.",
    );
  });

  test("E16: no such bucket, by code or by a 404 to HeadBucket; Silo's region does not make it a region error", () => {
    expectRow(
      mapped(server({ status: 404, code: "NoSuchBucket", region: "eu-central-1", bucketRegion: "eu-central-1" })),
      QueryError,
      'The server has no bucket "sales".',
    );
    expectRow(
      mapped(server({ status: 404, method: "HEAD", operation: "HeadBucket" }), "HeadBucket"),
      QueryError,
      'The server has no bucket "sales".',
    );
  });

  test("E17: a 404 with a delete marker, before NoSuchKey", () => {
    expectRow(
      mapped(
        server({
          status: 404,
          method: "HEAD",
          operation: "HeadObject",
          key: "a.csv",
          code: "NoSuchKey",
          deleteMarker: true,
        }),
        "HeadObject",
      ),
      QueryError,
      'The latest version of "a.csv" in bucket "sales" is a delete marker: the object was deleted.',
    );
  });

  test("E18a and E18b: no such key, by code or by a bare 404 to HeadObject", () => {
    expectRow(
      mapped(server({ status: 404, operation: "GetObject", key: "a.csv", code: "NoSuchKey" }), "GetObject"),
      QueryError,
      'The server has no object "a.csv" in bucket "sales".',
    );
    expectRow(
      mapped(server({ status: 404, method: "HEAD", operation: "HeadObject", key: "a.csv" }), "HeadObject"),
      QueryError,
      'The server answered 404 Not Found for "a.csv" in bucket "sales": the object, or the bucket, does not exist.',
    );
  });

  test("E19: a 2xx that is not the S3 document, and the ListBuckets element bound", () => {
    expectRow(
      mapped(server({ status: 200, problem: { kind: "not-s3", xml: "malformed" } })),
      QueryError,
      `The endpoint answered ${LIST} with something that is not an S3 answer: check that Port is the S3 API port (MinIO and RustFS serve their consoles on another port).`,
    );
    expectRow(
      mapped(
        server({ status: 200, operation: "ListBuckets", problem: { kind: "not-s3", xml: "too-many" } }),
        "ListBuckets",
      ),
      QueryError,
      "The server's list of buckets passed 100,000 XML elements, the most Studio reads for it: set Bucket on the connection to read one bucket without listing them.",
    );
  });

  test("E20: a refusal never says the bucket exists, signed or unsigned, and ListBuckets adds its hint", () => {
    expectRow(
      mapped(server({ status: 403, code: "AccessDenied", message: "Access Denied." })),
      QueryError,
      `This access key may not ${LIST} (s3:ListBucket). The server answers the same way for a bucket that does not exist, so this does not say that bucket "sales" exists.`,
    );
    expectRow(
      mapped(
        server({
          status: 403,
          code: "AccessDenied",
          message: "Access Denied.",
          region: "eu-central-1",
          bucketRegion: "eu-central-1",
        }),
        "ListObjectsV2",
        UNSIGNED,
      ),
      QueryError,
      `An unsigned request may not ${LIST} (s3:ListBucket): fill in Access key ID and Secret access key, or check that the bucket allows anonymous reads. The server answers the same way for a bucket that does not exist.`,
    );
    expectRow(
      mapped(server({ status: 403, operation: "ListBuckets", code: "AccessDenied" }), "ListBuckets"),
      QueryError,
      "This access key may not list buckets (s3:ListAllMyBuckets). The server answers the same way for a bucket that does not exist. A key limited to some buckets works with one of them under Bucket.",
    );
    expectRow(
      mapped(server({ status: 403, method: "HEAD", operation: "HeadObject", key: "a.csv" }), "HeadObject"),
      QueryError,
      `This access key may not ${READ} (s3:GetObject). The server answers the same way for an object that does not exist, so this does not say that object "a.csv" exists.`,
    );
  });

  test("E21 and E22: page defects and an over-long token", () => {
    expectRow(
      mapped(server({ status: 200, problem: { kind: "page", what: "1,001 entries for a page of at most 1,000" } })),
      QueryError,
      `The server answered ${LIST} with 1,001 entries for a page of at most 1,000, which a page cannot hold, so the page was not shown.`,
    );
    expectRow(
      mapped(server({ status: 200, problem: { kind: "token" } })),
      QueryError,
      "The server's continuation token is longer than 4,096 characters, so Studio cannot read on past this point: narrow the prefix.",
    );
  });

  test("E23: a refused continuation token, by name or by 501, only when one was sent", () => {
    const sentence = "The server refused this page's continuation token: list this folder again from its start.";
    expectRow(
      mapped(server({ status: 400, code: "InvalidRequest", message: "Invalid continuation token", sentToken: true })),
      QueryError,
      sentence,
    );
    expectRow(
      mapped(
        server({
          status: 400,
          code: "InvalidArgument",
          message: "The continuation token provided is incorrect",
          sentToken: true,
        }),
      ),
      QueryError,
      sentence,
    );
    expectRow(
      mapped(server({ status: 501, code: "NotImplemented", message: "outside the prefix", sentToken: true })),
      QueryError,
      sentence,
    );
    expect(
      mapped(server({ status: 400, code: "InvalidRequest", message: "Invalid continuation token" })).message,
    ).not.toBe(sentence);
  });

  test("E24 and E25: Garage's 501s", () => {
    expectRow(
      mapped(server({ status: 501, operation: "ListObjectVersions", code: "NotImplemented" }), "ListObjectVersions"),
      QueryError,
      "This server does not keep object versions: it answered 501 Not Implemented to ListObjectVersions.",
    );
    expectRow(
      mapped(
        server({ status: 501, operation: "GetObjectTagging", key: "a.csv", code: "NotImplemented" }),
        "GetObjectTagging",
      ),
      QueryError,
      'This server does not implement read the tags of object "a.csv": it answered 501 Not Implemented.',
    );
  });

  test("E26 and E27: names the server does not store", () => {
    expectRow(
      mapped(
        server({ status: 400, operation: "GetObject", key: "a//b", code: "XMinioInvalidObjectName" }),
        "GetObject",
      ),
      QueryError,
      "The server refuses this object name: it holds characters or empty segments the server does not store.",
    );
    const dots =
      "The server refuses a name with a . or .. segment or an empty segment, here in the key or the prefix: type it without such a segment.";
    expectRow(mapped(server({ status: 400, code: "XMinioInvalidResourceName" })), QueryError, dots);
    expectRow(
      mapped(server({ status: 400, operation: "GetObject", key: "a/./b", code: "InvalidArgument" }), "GetObject"),
      QueryError,
      dots,
    );
    expectRow(mapped(server({ status: 400, prefix: "a//", code: "InvalidArgument" })), QueryError, dots);
    expect(mapped(server({ status: 400, prefix: "a/b/", code: "InvalidArgument", message: "m" })).message).toBe(
      `The server refused ${LIST}: InvalidArgument: m`,
    );
  });

  test("E28: an archived object", () => {
    expectRow(
      mapped(server({ status: 403, operation: "GetObject", key: "a.csv", code: "InvalidObjectState" }), "GetObject"),
      QueryError,
      '"a.csv" is archived and must be restored before it can be read.',
    );
  });

  test("E29 and E30: an overloaded or failing server", () => {
    expectRow(
      mapped(server({ status: 503, code: "SlowDown" })),
      ConnectionError,
      "The server is overloaded (SlowDown); nothing was retried. Try again later.",
    );
    expectRow(
      mapped(server({ status: 503 })),
      ConnectionError,
      "The server is overloaded (HTTP 503); nothing was retried. Try again later.",
    );
    expectRow(
      mapped(server({ status: 500, code: "InternalError", message: "We encountered an internal error." })),
      QueryError,
      `The server failed while answering ${LIST} (InternalError). We encountered an internal error.`,
    );
    expectRow(mapped(server({ status: 502 })), QueryError, `The server failed while answering ${LIST} (HTTP 502).`);
  });

  test("E31: a bare 400 to a HEAD with no region header", () => {
    expectRow(
      mapped(server({ status: 400, method: "HEAD", operation: "HeadObject", key: "a.csv" }), "HeadObject"),
      QueryError,
      `The server refused ${READ} with 400 Bad Request and no reason. Garage answers a wrong region this way: check Region (this connection signs for us-east-1).`,
    );
  });

  test("E32: an error status whose body is not an S3 error document", () => {
    expectRow(
      mapped(server({ status: 409, operation: "GetBucketLocation", problem: { kind: "not-s3" } }), "GetBucketLocation"),
      QueryError,
      'The server answered HTTP 409 to read the location of bucket "sales" with a body that is not an S3 error document. Check that Host and Port name the S3 API.',
    );
  });

  test("E33: any other code, its message bounded and withheld when it holds a credential, the request id only when it is safe", () => {
    expect(mapped(server({ status: 400, code: "Weird", message: "m", requestId: "18DCDEC3B735E7CB" })).message).toBe(
      `The server refused ${LIST}: Weird: m (request id 18DCDEC3B735E7CB)`,
    );
    expect(
      mapped(server({ status: 400, code: "Weird", message: "m", requestId: "d290ad1b-0660-49c1-a540-a353a3b4b9d1" }))
        .message,
    ).toBe(`The server refused ${LIST}: Weird: m (request id d290ad1b-0660-49c1-a540-a353a3b4b9d1)`);
    expect(mapped(server({ status: 400, code: "Weird", message: "m", requestId: "a".repeat(129) })).message).toBe(
      `The server refused ${LIST}: Weird: m`,
    );
    expect(mapped(server({ status: 400, code: "Weird", message: "m", requestId: "has space" })).message).toBe(
      `The server refused ${LIST}: Weird: m`,
    );
    expect(mapped(server({ status: 400, code: "Weird", message: "the secret is test-secret-key" })).message).toBe(
      `The server refused ${LIST}: Weird: ${WITHHELD}`,
    );
    expect(mapped(server({ status: 400, code: "Weird", message: "x".repeat(400) })).message).toBe(
      `The server refused ${LIST}: Weird: ${"x".repeat(300)}`,
    );
    expect(mapped(server({ status: 400, code: "Bad Code!", message: "m" })).message).toBe(
      `The server refused ${LIST}: an unnamed code: m`,
    );
    expect(mapped(server({ status: 400, code: "InvalidRange" })).message).toBe(
      `The server refused ${LIST}: InvalidRange`,
    );
  });

  test("E34: any other status with no code", () => {
    expectRow(mapped(server({ status: 418 })), QueryError, `The server answered HTTP 418 to ${LIST} with no reason.`);
  });
});

describe("a value the failed request must carry is a defect when it was never noted", () => {
  const defect = (operation: S3Operation, what: string) =>
    `The S3 error mapping got a failed ${operation} with no ${what} noted.`;

  test("a ListBuckets failure asks for no name", () => {
    expectRow(
      mapped(new TransportError("timeout", "timed out"), "ListBuckets", SIGNED, { timeoutMs: 10_000 }),
      TimeoutError,
      "The S3 server at http://localhost:9000 did not answer list buckets within 10 seconds; nothing was retried.",
    );
    expect(
      mapped(server({ status: 403, operation: "ListBuckets", bucket: undefined, code: "AccessDenied" }), "ListBuckets"),
    ).toBeInstanceOf(QueryError);
  });

  test("a transport failure of a bucket verb with no bucket noted", () => {
    expect(() => mapped(new TransportError("timeout", "timed out"), "ListObjectsV2")).toThrow(
      defect("ListObjectsV2", "bucket"),
    );
  });

  test("a transport failure of an object verb with no key noted", () => {
    const error = new TransportError("timeout", "timed out");
    noteRequestNames(error, { bucket: "sales" });
    expect(() => mapped(error, "GetObject")).toThrow(defect("GetObject", "key"));
  });

  test("an answer over its cap with no cap noted", () => {
    const error = new TransportError("too-large", "too large");
    noteRequestNames(error, { bucket: "sales" });
    expect(() => mapped(error)).toThrow(defect("ListObjectsV2", "response cap"));
  });

  test("a timeout with no deadline noted", () => {
    const error = new TransportError("timeout", "timed out");
    noteRequestNames(error, { bucket: "sales" });
    expect(() => mapped(error)).toThrow(defect("ListObjectsV2", "deadline"));
  });

  test("a redirect that carries no status", () => {
    const error = new TransportError("redirect", "redirected");
    noteRequestNames(error, { bucket: "sales" });
    expect(() => mapped(error)).toThrow(defect("ListObjectsV2", "redirect status"));
  });

  test("a server answer to a bucket verb with no bucket", () => {
    expect(() => mapped(server({ status: 403, bucket: undefined, code: "AccessDenied" }))).toThrow(
      defect("ListObjectsV2", "bucket"),
    );
  });

  test("a server answer to an object verb with no key", () => {
    expect(() => mapped(server({ status: 404, operation: "GetObject", code: "NoSuchKey" }), "GetObject")).toThrow(
      defect("GetObject", "key"),
    );
  });

  test("NoSuchKey answering a bucket verb falls through to the row that quotes the server's code", () => {
    expectRow(mapped(server({ status: 404, code: "NoSuchKey" })), QueryError, `The server refused ${LIST}: NoSuchKey`);
  });

  test("NoSuchBucket answering ListBuckets falls through to the row that quotes the server's code", () => {
    expectRow(
      mapped(server({ status: 404, operation: "ListBuckets", bucket: undefined, code: "NoSuchBucket" }), "ListBuckets"),
      QueryError,
      "The server refused list buckets: NoSuchBucket",
    );
  });
});

describe("the verb table and the fields", () => {
  test("each operation's words, IAM action and noun", () => {
    expect(S3_VERBS.ListBuckets.op("", "")).toBe("list buckets");
    expect(S3_VERBS.HeadBucket.op('"b"', "")).toBe('list bucket "b"');
    expect(S3_VERBS.GetBucketVersioning.op('"b"', "")).toBe('read the versioning of bucket "b"');
    expect(S3_VERBS.ListObjectVersions.op('"b"', "")).toBe('list object versions in bucket "b"');
    expect(S3_VERBS.GetObject.op('"b"', '"k"')).toBe('read object "k" in bucket "b"');
    expect(Object.values(S3_VERBS).map((verb) => verb.action)).toEqual([
      "s3:ListAllMyBuckets",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:GetObject",
      "s3:GetObject",
      "s3:GetObjectTagging",
    ]);
  });

  test("S3ServerError keeps the server's message apart from its own, and fieldsOf gives the fields back", () => {
    const error = server({ status: 403, code: "AccessDenied", message: "Access Denied." });
    expect(error.message).toBe("S3 ListObjectsV2 answered HTTP 403");
    expect(error.serverMessage).toBe("Access Denied.");
    expect(fieldsOf(error)).toEqual({
      operation: "ListObjectsV2",
      method: "GET",
      bucket: "sales",
      status: 403,
      code: "AccessDenied",
      message: "Access Denied.",
    });
  });

  test("every sentence is exported", () => {
    expect(S3_ERROR_SENTENCES.cursorTooLong).toBe(
      "The position of the next page is too long for a Keys panel cursor, so the Keys panel cannot page past this point: narrow the prefix.",
    );
    expect(Object.isFrozen(S3_ERROR_SENTENCES)).toBe(true);
  });
});
