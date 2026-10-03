/**
 * The Qdrant error table (vector-family spec 6.10, QE20). Every server text below is one the research measured on
 * Qdrant 1.19.1, copied verbatim; the captures of tests/fixtures/qdrant/ hold the table to the live server again in
 * qdrant-fixtures.test.ts.
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
import { type QdrantAnswer, QdrantError } from "@/lib/db/providers/vector/qdrant/client";
import {
  answerFailure,
  expectOk,
  type QdrantErrorContext,
  retryAfterSeconds,
  toProviderError,
} from "@/lib/db/providers/vector/qdrant/errors";
import { secretForms } from "@/lib/db/utils/server-text";

// Named stand-ins, never realistic values: a credential in a test fixture is a placeholder.
const TEST_PASSWORD = "password";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";
const NOW = new Date("2026-10-03T12:00:00Z");

const CONTEXT: QdrantErrorContext = {
  phase: "request",
  op: "scroll_points",
  endpoint: { host: "qdrant.test", port: 6333 },
  responseCapBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
  secretForms: secretForms([TEST_PASSWORD]),
  now: () => NOW,
};

const json = (status: number, error: string, retryAfter: string | null = null): QdrantAnswer => ({
  status,
  contentType: "application/json",
  retryAfter,
  text: JSON.stringify({ status: { error }, time: 0 }),
});
const plain = (status: number, text: string): QdrantAnswer => ({
  status,
  contentType: "text/plain; charset=utf-8",
  retryAfter: null,
  text,
});

function worded(answer: QdrantAnswer, context: QdrantErrorContext = CONTEXT): Error {
  const failure = answerFailure(answer);
  if (failure === undefined) throw new Error("the answer is a success");
  return toProviderError(failure, context);
}

describe("answerFailure: the status decides, the text refines", () => {
  test("a 2xx is no failure", () => {
    expect(answerFailure(json(200, "ignored"))).toBeUndefined();
    expect(answerFailure(plain(204, ""))).toBeUndefined();
    expect(answerFailure(plain(299, ""))).toBeUndefined();
  });

  test.each([
    [plain(401, "Must provide an API key or an Authorization bearer token"), "unauthenticated"],
    [plain(401, "Invalid API key or JWT"), "unauthenticated"],
    [plain(403, "ExpiredSignature"), "jwt-expired"],
    [plain(403, "InvalidSignature"), "jwt-signature"],
    [json(403, "Forbidden: Global manage access is required"), "forbidden"],
    [json(403, "Forbidden: Access to collection docs_alias is required"), "forbidden"],
    [plain(403, "Forbidden: Global manage access is required"), "forbidden"],
    [json(404, "Not found: Collection `nope` doesn't exist!"), "collection-not-found"],
    [json(404, "Not found: Point with id 999999 does not exists!"), "not-found"],
    [plain(404, ""), "not-found"],
    [json(400, "Format error in JSON body: expected value at line 1 column 1"), "input"],
    [json(422, "Validation error in JSON body: [limit: value 0 invalid, must be 1 or larger]"), "input"],
    [json(400, "Wrong input: Not existing vector name error: "), "input"],
    [
      json(400, 'Bad request: Limit exceeded 50 > 5 for "limit". Help: Reduce the "limit" parameter to or below 5.'),
      "strict-mode",
    ],
    [
      json(
        400,
        'Bad request: Index required but not found for "title" of one of the following types: [keyword]. Help: Create an index for this key or use a different filter.',
      ),
      "strict-mode",
    ],
    [json(400, "Bad request: Exact search disabled!. Help: Set exact=false."), "strict-mode"],
    // Strict mode is only the three measured refusals; any other "Bad request:" is the request's own input.
    [json(400, 'Bad request: Shard key "x" not found'), "input"],
    [
      json(
        429,
        "Rate limiting exceeded: Read rate limit exceeded: Operation requires 1 tokens but only 0.0 were available. Retry after 10s",
        "10",
      ),
      "rate-limited",
    ],
    [
      json(
        500,
        "Service internal error: 1 of 1 read operations failed: | Timeout error: Operation 'count' timed out after 3s",
      ),
      "timeout",
    ],
    [json(408, "Timeout: Timeout error: Operation 'GroupBy' timed out after 3s"), "timeout"],
    [json(500, "Service internal error: a stand-in failure"), "server"],
    [json(502, "Bad gateway"), "server"],
    [json(503, "Service unavailable"), "unavailable"],
    [json(405, "Qdrant is running in standalone mode"), "unexpected-status"],
    [json(408, "Request timeout"), "unexpected-status"],
    [plain(302, ""), "unexpected-status"],
  ] as const)("%j is %s", (answer, category) => {
    const failure = answerFailure(answer) as QdrantError;
    expect(failure).toBeInstanceOf(QdrantError);
    expect(failure.category).toBe(category);
    expect(failure.status).toBe(answer.status);
  });

  test("the detail is the server's own words, and the message never carries them", () => {
    const failure = answerFailure(json(403, "Forbidden: Global manage access is required")) as QdrantError;
    expect(failure.detail).toBe("Forbidden: Global manage access is required");
    expect(failure.message).toBe("Qdrant answered HTTP 403 (forbidden)");
    expect((answerFailure(plain(401, " Invalid API key or JWT\n")) as QdrantError).detail).toBe(
      "Invalid API key or JWT",
    );
  });

  test("a body that is JSON without status.error, or too long to be a refusal, is read as text", () => {
    expect((answerFailure(plain(500, '{"message":"x"}')) as QdrantError).detail).toBe('{"message":"x"}');
    expect((answerFailure(plain(500, '"text"')) as QdrantError).detail).toBe('"text"');
    expect((answerFailure(plain(500, "null")) as QdrantError).detail).toBe("null");
    expect((answerFailure(plain(500, '{"status":"error"}')) as QdrantError).detail).toBe('{"status":"error"}');
    const long = JSON.stringify({ status: { error: "x".repeat(70_000) } });
    expect((answerFailure(plain(500, long)) as QdrantError).detail).toBe(long);
  });

  test("only a 429 keeps the Retry-After header", () => {
    expect((answerFailure(json(429, "Rate limiting exceeded", "10")) as QdrantError).retryAfter).toBe("10");
    expect((answerFailure(json(429, "Rate limiting exceeded")) as QdrantError).retryAfter).toBeNull();
    expect((answerFailure(json(503, "busy", "10")) as QdrantError).retryAfter).toBeNull();
  });
});

describe("retryAfterSeconds (6.10)", () => {
  const ahead = new Date(NOW.getTime() + 30_000).toUTCString();
  const past = new Date(NOW.getTime() - 30_000).toUTCString();

  test.each([
    ["10", 10],
    ["0", 0],
    ["999999999", 999_999_999],
    [ahead, 30],
    [past, 0],
  ] as const)("%s is %d s", (value, seconds) => {
    expect(retryAfterSeconds(value, NOW)).toBe(seconds);
  });

  test("a date a fraction of a second ahead rounds up to a whole second", () => {
    expect(retryAfterSeconds(ahead, new Date(NOW.getTime() + 500))).toBe(30);
    expect(retryAfterSeconds(ahead, new Date(NOW.getTime() - 500))).toBe(31);
  });

  test.each(["-5", "1.5", "abc", "", " 10", "1234567890", "2026-10-03T12:00:30Z", "Sat, 03 Oct 2026 12:00:30 +0000"])(
    "%j names no wait",
    (value) => {
      expect(retryAfterSeconds(value, NOW)).toBeUndefined();
    },
  );

  test("an IMF-fixdate that is no real date, and an absent header, name no wait", () => {
    expect(retryAfterSeconds("Sat, 99 Oct 2026 12:00:30 GMT", NOW)).toBeUndefined();
    expect(retryAfterSeconds(null, NOW)).toBeUndefined();
  });
});

describe("toProviderError: Studio's sentence first, the server's text after it (QE20)", () => {
  test("a 401 is an authentication error with the server text", () => {
    const error = worded(plain(401, "Invalid API key or JWT"));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe("Qdrant refused the API key or JWT. (Qdrant: Invalid API key or JWT)");
    expect(String((error as AuthenticationError).provider)).toBe("qdrant");
  });

  test("an expired JWT and a bad signature read as themselves, never as a permission problem", () => {
    const expired = worded(plain(403, "ExpiredSignature"));
    expect(expired).toBeInstanceOf(AuthenticationError);
    expect(expired.message).toBe("The JWT has expired.");
    const signature = worded(plain(403, "InvalidSignature"));
    expect(signature).toBeInstanceOf(AuthenticationError);
    expect(signature.message).toBe("The JWT's signature does not match this server's key.");
  });

  test("any other 403 names what the credential may not do: this request, or listing collections at connect", () => {
    const answer = json(403, "Forbidden: Access to collection docs_alias is required");
    const request = worded(answer);
    expect(request).toBeInstanceOf(QueryError);
    expect(request.message).toBe(
      "The credential is not allowed to run this request. (Qdrant: Forbidden: Access to collection docs_alias is required)",
    );
    const connect = worded(answer, { ...CONTEXT, phase: "connect", op: "get_collections" });
    expect(connect).toBeInstanceOf(AuthenticationError);
    expect(connect.message).toBe(
      "The credential is not allowed to list collections. (Qdrant: Forbidden: Access to collection docs_alias is required)",
    );
  });

  test("a missing collection reads as missing or not visible", () => {
    const error = worded(json(404, "Not found: Collection `nope` doesn't exist!"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("The collection does not exist or is not visible to this credential.");
  });

  test("any other 404 carries the server's text, and a bodyless one only Studio's sentence", () => {
    expect(worded(json(404, "Not found: Point with id 999999 does not exists!")).message).toBe(
      "Qdrant found nothing at the name or id the request gives. (Qdrant: Not found: Point with id 999999 does not exists!)",
    );
    expect(worded(plain(404, "")).message).toBe("Qdrant found nothing at the name or id the request gives.");
  });

  test.each([
    [
      400,
      "Format error in JSON body: data did not match any variant of untagged enum MatchInterface at line 1 column 70",
    ],
    [422, "Validation error in JSON body: [limit: value 0 invalid, must be 1 or larger]"],
    [400, "Wrong input: Vector dimension error: expected dim: 4, got 2"],
  ] as const)("an input refusal (%d) carries the server's text after the input sentence", (status, text) => {
    const error = worded(json(status, text));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(`Qdrant did not accept the request as written. (Qdrant: ${text})`);
  });

  test("a strict-mode text is shown verbatim after Studio's sentence, with the exact hint where it applies", () => {
    const limit = 'Bad request: Limit exceeded 50 > 5 for "limit". Help: Reduce the "limit" parameter to or below 5.';
    expect(worded(json(400, limit)).message).toBe(
      `This collection's strict mode refused the request. (Qdrant: ${limit})`,
    );
    const exact = "Bad request: Exact search disabled!. Help: Set exact=false.";
    expect(worded(json(400, exact)).message).toBe(
      `This collection's strict mode refused the request. Send "exact": false. (Qdrant: ${exact})`,
    );
  });

  test.each([
    ["10", "try again in 10 s"],
    ["0", "try again in 0 s"],
    [new Date(NOW.getTime() + 30_000).toUTCString(), "try again in 30 s"],
    [new Date(NOW.getTime() - 30_000).toUTCString(), "try again in 0 s"],
    ["-5", "try again later"],
    ["1.5", "try again later"],
    ["abc", "try again later"],
    [null, "try again later"],
  ] as const)("a 429 with Retry-After %j says %s, as a query error, and never echoes the header", (header, wait) => {
    const error = worded(json(429, "Rate limiting exceeded: Read rate limit exceeded", header));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.name).toBe("QueryError");
    expect(error.message).toBe(
      `Qdrant rate-limited the request; ${wait}. It was not sent again. (Qdrant: Rate limiting exceeded: Read rate limit exceeded)`,
    );
  });

  test("a 429 with no clock in the context reads the system clock", () => {
    const withoutClock: QdrantErrorContext = { ...CONTEXT, now: undefined };
    const ahead = new Date(Date.now() + 3_600_000).toUTCString();
    expect(worded(json(429, "Rate limiting exceeded", ahead), withoutClock).message).toMatch(
      /try again in (3599|3600) s\./,
    );
  });

  test("both timeout shapes read as the timeout, without the server's elapsed figure", () => {
    for (const answer of [
      json(
        500,
        "Service internal error: 1 of 1 read operations failed: | Timeout error: Operation 'Search' timed out after 2.999836247s",
      ),
      json(408, "Timeout: Timeout error: Operation 'GroupBy' timed out after 3s"),
    ]) {
      const error = worded(answer);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toBe("Qdrant stopped the request at its time limit.");
      expect((error as TimeoutError).timeout).toBe(30_000);
    }
  });

  test("a timed-out exact count states the limit and the hint", () => {
    const error = worded(
      json(
        500,
        "Service internal error: 1 of 1 read operations failed: | Timeout error: Operation 'count' timed out after 3s",
      ),
      { ...CONTEXT, op: "count_points" },
    );
    expect(error.message).toBe(
      'Qdrant stopped the request at its time limit. An exact count keeps running on the server after its time limit, until it completes; send "exact": false for an approximate count.',
    );
  });

  test("another 500 is a query error, a 503 a connection error, each with the server text", () => {
    const failed = worded(json(500, "Service internal error: a stand-in failure"));
    expect(failed).toBeInstanceOf(QueryError);
    expect(failed.message).toBe(
      "Qdrant failed to run the request (HTTP 500). (Qdrant: Service internal error: a stand-in failure)",
    );
    const busy = worded(json(503, "Service unavailable"));
    expect(busy).toBeInstanceOf(ConnectionError);
    expect(busy.message).toBe("Qdrant is not ready to serve the request (HTTP 503). (Qdrant: Service unavailable)");
    expect((busy as ConnectionError).host).toBe("qdrant.test");
    expect((busy as ConnectionError).port).toBe(6333);
  });

  test("a status no row reads is named", () => {
    expect(worded(json(405, "Qdrant is running in standalone mode")).message).toBe(
      "Qdrant answered HTTP 405, which Studio does not read. (Qdrant: Qdrant is running in standalone mode)",
    );
  });

  test("a server text longer than 2,000 characters is cut, and says so", () => {
    const message = worded(json(500, "x".repeat(2500))).message;
    expect(message).toBe(`Qdrant failed to run the request (HTTP 500). (Qdrant: ${"x".repeat(2000)} (cut))`);
  });
});

describe("an echoed credential is withheld in every place a server text reaches a sentence (QE4, VF9)", () => {
  const jwt = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from('{"access":"r"}').toString("base64url"),
    Buffer.from("signature-stand-in").toString("base64url"),
  ].join(".");
  const echoes = (secret: string, forms: readonly string[]) =>
    [
      [plain(401, `Invalid API key or JWT: ${secret}`), forms],
      [json(403, `Forbidden: key ${secret} lacks access`), forms],
      [json(400, `Bad request: Limit exceeded for ${secret}`), forms],
      [json(400, `Format error in JSON body: ${secret}`), forms],
      [json(404, `Not found: Point ${secret}`), forms],
      [json(429, `Rate limiting exceeded for ${secret}`), forms],
      [json(500, `Service internal error: ${secret}`), forms],
      [json(503, `Unavailable for ${secret}`), forms],
      [json(405, `Not allowed for ${secret}`), forms],
    ] as const;

  test.each([
    ...echoes(TEST_PASSWORD, secretForms([TEST_PASSWORD])),
    ...echoes(Buffer.from(TEST_PASSWORD).toString("base64"), secretForms([TEST_PASSWORD])),
    ...echoes(jwt, secretForms([jwt])),
    ...jwt.split(".").flatMap((segment) => echoes(segment, secretForms([jwt]))),
  ])("%j", (answer, forms) => {
    const message = worded(answer, { ...CONTEXT, secretForms: forms }).message;
    expect(message).toContain(WITHHELD);
    for (const form of forms) expect(message).not.toContain(form);
  });

  test("with no secret configured, the text is shown", () => {
    expect(worded(plain(401, "Invalid API key or JWT"), { ...CONTEXT, secretForms: [] }).message).toContain(
      "(Qdrant: Invalid API key or JWT)",
    );
  });
});

describe("toProviderError: a request that never completed (6.10, QE3)", () => {
  const transport = (kind: TransportError["kind"], message: string) =>
    toProviderError(new TransportError(kind, message), CONTEXT);

  test("a deadline is a timeout that names the limit, and an exact count's adds the stated limit", () => {
    const error = transport("timeout", "The request did not finish within its time limit");
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("The request to Qdrant did not finish within 30000 ms, so Studio stopped waiting.");
    expect(toProviderError(new TransportError("timeout", "x"), { ...CONTEXT, op: "count_points" }).message).toContain(
      'send "exact": false for an approximate count.',
    );
  });

  test("a cancel is a cancellation", () => {
    const error = transport("aborted", "The request was cancelled");
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The request to Qdrant was cancelled.");
  });

  test("an answer past the cap names the cap", () => {
    const error = transport("too-large", "The response exceeded the 16777216-byte limit for one response");
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "Qdrant's answer is larger than the 16 MiB Studio reads for one response, so it was not read. Ask for fewer points, or leave the vectors out.",
    );
    expect(
      toProviderError(new TransportError("too-large", "x"), { ...CONTEXT, responseCapBytes: 2048 }).message,
    ).toContain("larger than the 2 KiB Studio reads");
    expect(
      toProviderError(new TransportError("too-large", "x"), { ...CONTEXT, responseCapBytes: 1500 }).message,
    ).toContain("larger than the 1,500 bytes Studio reads");
  });

  test("past the cap, the error names the request's limit and the vectors it asked for (spec 6.6)", () => {
    const tooLarge = (requestBody: string) =>
      toProviderError(new TransportError("too-large", "x"), { ...CONTEXT, requestBody }).message;
    const CAP = "Qdrant's answer is larger than the 16 MiB Studio reads for one response, so it was not read.";
    const ADVICE = "Lower limit, or set with_vector to false or to the vectors needed.";
    expect(tooLarge('{"limit":1000,"with_vector":true}')).toBe(
      `${CAP} The request asked for limit 1000 with every vector. ${ADVICE}`,
    );
    expect(tooLarge('{"limit":50,"with_vector":["text","colbert"]}')).toBe(
      `${CAP} The request asked for limit 50 with the vectors "text", "colbert". ${ADVICE}`,
    );
    expect(tooLarge('{"limit":10,"with_vectors":true}')).toBe(
      `${CAP} The request asked for limit 10 with every vector. ${ADVICE}`,
    );
    expect(tooLarge('{"limit":10,"with_vector":false}')).toBe(
      `${CAP} The request asked for limit 10 with no vectors. ${ADVICE}`,
    );
    expect(tooLarge('{"ids":[1,2,3],"with_vector":true}')).toBe(
      `${CAP} The request asked for 3 ids with every vector. ${ADVICE}`,
    );
    expect(tooLarge('{"searches":[{"limit":10,"with_vector":true},{"limit":5}]}')).toBe(
      `${CAP} The request's searches asked for limit 10 with every vector; limit 5 with no vectors. ${ADVICE}`,
    );
  });

  test.each([
    [
      "redirect",
      "The server answered HTTP 307, a redirect to http://127.0.0.1:9, and redirects are not followed",
      "answered with a redirect, which Studio never follows.",
    ],
    [
      "encoding",
      "The server answered with content-encoding gzip, and this transport reads identity only, so the response was not read",
      "answered in an encoding Studio does not read.",
    ],
    [
      "tls",
      "The TLS connection failed (DEPTH_ZERO_SELF_SIGNED_CERT)",
      "failed: check the SSL mode, the CA and the client certificate under SSL / TLS.",
    ],
    [
      "network",
      "The request failed before a complete response arrived (ECONNRESET)",
      "and the request was not sent again.",
    ],
  ] as const)(
    "a %s failure is a connection error naming the endpoint and the transport's cause",
    (kind, cause, words) => {
      const error = transport(kind, cause);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error.message).toContain("qdrant.test:6333");
      expect(error.message).toContain(words);
      expect(error.message.endsWith(cause)).toBe(true);
      expect((error as ConnectionError).host).toBe("qdrant.test");
    },
  );

  test("an IPv6 endpoint is written in brackets", () => {
    const error = toProviderError(new TransportError("network", "x"), {
      ...CONTEXT,
      endpoint: { host: "::1", port: 6333 },
    });
    expect(error.message).toContain("[::1]:6333");
  });

  test("a refusal raised before the wire is returned as it is", () => {
    const refusal = new DatabaseConfigError("Invalid host: expected a hostname, an IPv4 address or an IPv6 address");
    expect(toProviderError(refusal, CONTEXT)).toBe(refusal);
  });

  test("anything else is reported without its text", () => {
    const error = toProviderError(new Error(`boom ${TEST_PASSWORD}`), CONTEXT);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("The request to Qdrant failed in a way Studio does not recognise.");
    expect(toProviderError("text", CONTEXT).message).toBe(
      "The request to Qdrant failed in a way Studio does not recognise.",
    );
  });
});

describe("expectOk", () => {
  test("a success is handed back, and a failure is thrown worded", () => {
    const ok: QdrantAnswer = { status: 200, contentType: "application/json", retryAfter: null, text: "{}" };
    expect(expectOk(ok, CONTEXT)).toBe(ok);
    expect(() => expectOk(plain(401, "Invalid API key or JWT"), CONTEXT)).toThrow(
      "Qdrant refused the API key or JWT. (Qdrant: Invalid API key or JWT)",
    );
  });
});
