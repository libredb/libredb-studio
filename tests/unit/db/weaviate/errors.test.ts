/**
 * The Weaviate error table (#1566 spec 5.6, doc section 10): the category the status and the server's words decide,
 * the class and sentence each category reads as, the server's words withheld whole when they hold the secret, and a
 * request that never completed.
 *
 * The 401, the TLS 400 and the bodyless 404 are the answers live servers gave, read from tests/fixtures/weaviate/.
 * Every other server text is written in the shape errors.ts documents (`{"error":[{"message"}]}` from a handler,
 * `{"code","message"}` from the router, `{"errors":[{"message"}]}` from GraphQL), with the words the phase 0
 * measurements recorded, and its test name says "in the documented shape".
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
import { type WeaviateAnswer, WeaviateError, type WeaviateOp } from "@/lib/db/providers/vector/weaviate/client";
import {
  answerFailure,
  expectOk,
  graphqlFailure,
  retryAfterSeconds,
  serverWords,
  toProviderError,
  type WeaviateErrorContext,
} from "@/lib/db/providers/vector/weaviate/errors";
import { secretForms } from "@/lib/db/utils/server-text";
import { capturedAnswer } from "../../../helpers/weaviate-wire";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

const CONTEXT: WeaviateErrorContext = {
  phase: "request",
  op: "objects",
  endpoint: { host: "weaviate.test", port: 8080 },
  responseCapBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
  secretForms: secretForms([TEST_PASSWORD]),
};

const NO_KEY = capturedAnswer("weaviate-auth/no-key.json", "GET /v1/meta");
const WRONG_KEY = capturedAnswer("weaviate-auth/wrong-key.json", "GET /v1/meta");
const PLAIN_TO_TLS = capturedAnswer("weaviate-tls/plain-to-tls.json", "GET /v1/meta");
const NO_OBJECT = capturedAnswer(
  "weaviate-1-37/reads.json",
  "GET /v1/objects/Article/00000000-0000-0000-0000-000000000000",
);

const handler = (status: number, ...messages: string[]): WeaviateAnswer => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify({ error: messages.map((message) => ({ message })) }),
});
const router = (status: number, message: string): WeaviateAnswer => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify({ code: status, message }),
});
const graphql = (...messages: string[]): WeaviateAnswer => ({
  status: 200,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify({ data: { Get: { Article: null } }, errors: messages.map((message) => ({ message })) }),
});
const plain = (status: number, text: string, retryAfter: string | null = null): WeaviateAnswer => ({
  status,
  contentType: "text/plain; charset=utf-8",
  retryAfter,
  text,
});

const RBAC =
  "rbac: authorization, forbidden action(s): [read_data] on resource(s) [Domain: data, Collection: Article, Tenant: *, Object: *]";
const SCOPE =
  "due to GraphQL introspection, this role must have the permission to read_collections on * (all) collections";
const ROUTE_ABSENT = "path /v1/search/Article/bm25 was not found";
const NO_COLLECTION = "could not find collection Nope";
const UNKNOWN_CLASS = 'Cannot query field "Nope" on type "GetObjectsObj".';
const UNKNOWN_AGGREGATE = 'Cannot query field "Nope" on type "AggregateObjectsObj".';
const TENANT_COLD = 'tenant not active: "tenantA" is COLD';
const REST_FLAG = "rest search api is experimental and not enabled";
const GRAPHQL_OFF = "graphql api is disabled";
const LIMIT = "query maximum results exceeded: limit 20000 > QUERY_MAXIMUM_RESULTS 10000";

function failureOf(answer: WeaviateAnswer): WeaviateError {
  const failure = answerFailure(answer);
  if (failure === undefined) throw new Error("the answer is a success");
  return failure;
}

const worded = (answer: WeaviateAnswer, context: WeaviateErrorContext = CONTEXT): Error =>
  toProviderError(failureOf(answer), context);

describe("serverWords: every message of the error body, else the body as text", () => {
  test("the captured 401s give their router message", () => {
    expect(serverWords(NO_KEY.text)).toBe(
      "anonymous access not enabled. Please authenticate through one of the available methods: [API-keys]",
    );
    expect(serverWords(WRONG_KEY.text)).toBe("unauthorized: invalid api key");
  });

  test("a handler's and GraphQL's lists give every message, joined, skipping entries with no text message", () => {
    expect(serverWords(handler(422, "first", "second").text)).toBe("first; second");
    expect(
      serverWords(JSON.stringify({ errors: [{ message: "a" }, null, 7, { message: 3 }, {}, { message: "b" }] })),
    ).toBe("a; b");
    expect(serverWords(JSON.stringify({ error: [{ message: "h" }], errors: [{ message: "g" }] }))).toBe("h; g");
  });

  test("with no listed message, a string message, then a string error, is the words", () => {
    expect(serverWords(JSON.stringify({ error: [], message: "routed" }))).toBe("routed");
    expect(serverWords(JSON.stringify({ error: "plain error" }))).toBe("plain error");
  });

  test("a body that is not JSON, JSON without those fields, or too long to be a refusal, is the trimmed text", () => {
    expect(serverWords(PLAIN_TO_TLS.text)).toBe("Client sent an HTTP request to an HTTPS server.");
    expect(serverWords('  {"status":"down"}  ')).toBe('{"status":"down"}');
    expect(serverWords('"text"')).toBe('"text"');
    expect(serverWords("null")).toBe("null");
    expect(serverWords("[1]")).toBe("[1]");
    expect(serverWords(JSON.stringify({ error: { message: "nested" } }))).toBe('{"error":{"message":"nested"}}');
    const long = JSON.stringify({ error: [{ message: "x".repeat(70_000) }] });
    expect(serverWords(long)).toBe(long);
    expect(serverWords("")).toBe("");
  });
});

describe("answerFailure: the status decides, the words refine", () => {
  test("a 2xx is no failure", () => {
    for (const status of [200, 204, 299]) expect(answerFailure(plain(status, ""))).toBeUndefined();
  });

  test.each([
    ["the captured no-key 401", NO_KEY, "unauthenticated"],
    ["the captured wrong-key 401", WRONG_KEY, "unauthenticated"],
    ["a 403 RBAC refusal in the documented shape", handler(403, RBAC), "forbidden"],
    ["a 403 GraphQL scope refusal in the documented shape", handler(403, SCOPE), "graphql-scope"],
    ["a router 404 in the documented shape", router(404, ROUTE_ABSENT), "route-absent"],
    ["a 404 missing collection in the documented shape", handler(404, NO_COLLECTION), "collection-not-found"],
    ["a 404 unknown GraphQL class in the documented shape", handler(404, UNKNOWN_CLASS), "collection-not-found"],
    ["the captured bodyless 404 of an object", NO_OBJECT, "not-found"],
    ["a 404 with other words", handler(404, "tenant not found: tenantZ"), "not-found"],
    ["a 404 naming a tenant that is not active", handler(404, TENANT_COLD), "not-found"],
    ["a router 404 for another kind of path", router(404, "path /v1/a b was not found"), "not-found"],
    ["a 422 cold tenant in the documented shape", handler(422, TENANT_COLD), "tenant-not-active"],
    ["a 422 REST search behind its flag in the documented shape", handler(422, REST_FLAG), "rest-search-disabled"],
    ["a 422 with GraphQL disabled in the documented shape", handler(422, GRAPHQL_OFF), "graphql-disabled"],
    ["a 422 GraphQL scope refusal in the documented shape", handler(422, SCOPE), "graphql-scope"],
    ["a 422 missing collection in the documented shape", handler(422, NO_COLLECTION), "collection-not-found"],
    ["a 400 unknown aggregate class in the documented shape", handler(400, UNKNOWN_AGGREGATE), "collection-not-found"],
    ["a 400 past QUERY_MAXIMUM_RESULTS in the documented shape", handler(400, LIMIT), "result-limit"],
    ["the captured TLS listener's 400", PLAIN_TO_TLS, "tls-required"],
    ["a 422 RBAC refusal in the documented shape", handler(422, RBAC), "forbidden"],
    ["a 400 with other words", handler(400, "invalid 'limit': must be positive"), "input"],
    ["a 422 with other words", handler(422, "no graphql provider present"), "input"],
    ["a 429", plain(429, "too many requests", "7"), "rate-limited"],
    ["a 500", handler(500, "an internal stand-in failure"), "server"],
    ["a 502", plain(502, "Bad Gateway"), "server"],
    ["a 503", plain(503, "not ready"), "unavailable"],
    ["a 302", plain(302, ""), "unexpected-status"],
    ["a 405", plain(405, "method not allowed"), "unexpected-status"],
    ["a 409", handler(409, TENANT_COLD), "unexpected-status"],
    ["a 199", plain(199, ""), "unexpected-status"],
  ] as const)("%s is %s", (_what, answer, category) => {
    const failure = failureOf(answer);
    expect(failure).toBeInstanceOf(WeaviateError);
    expect(failure.category).toBe(category);
    expect(failure.status).toBe(answer.status);
  });

  test("the detail is the server's words, and the message never carries them", () => {
    const failure = failureOf(handler(403, RBAC));
    expect(failure.detail).toBe(RBAC);
    expect(failure.message).toBe("Weaviate answered HTTP 403 (forbidden)");
    expect(failure.name).toBe("WeaviateError");
  });

  test("only a 429 keeps the Retry-After header", () => {
    expect(failureOf(plain(429, "slow down", "7")).retryAfter).toBe("7");
    expect(failureOf(plain(429, "slow down")).retryAfter).toBeNull();
    expect(failureOf(plain(503, "busy", "7")).retryAfter).toBeNull();
  });
});

describe("graphqlFailure: GraphQL answers its refusals under HTTP 200", () => {
  test("a status that is not 2xx reads as answerFailure reads it", () => {
    expect(graphqlFailure(handler(422, GRAPHQL_OFF))?.category).toBe("graphql-disabled");
    expect(graphqlFailure(NO_KEY)?.category).toBe("unauthenticated");
  });

  test("a 200 whose body holds no errors is no failure", () => {
    expect(graphqlFailure(plain(200, JSON.stringify({ data: { Get: { Article: [] } } })))).toBeUndefined();
    expect(graphqlFailure(plain(200, JSON.stringify({ data: {}, errors: [] })))).toBeUndefined();
    expect(graphqlFailure(plain(200, JSON.stringify({ errors: "one" })))).toBeUndefined();
    expect(graphqlFailure(plain(200, "null"))).toBeUndefined();
    expect(graphqlFailure(plain(200, "[]"))).toBeUndefined();
  });

  test("a 200 that is not JSON is an unexpected status with no words", () => {
    const failure = graphqlFailure(plain(200, "<html>proxy</html>"));
    expect(failure?.category).toBe("unexpected-status");
    expect(failure?.detail).toBe("");
    expect(failure?.status).toBe(200);
  });

  test.each([
    ["a cold tenant", [TENANT_COLD], "tenant-not-active"],
    ["the scope refusal", [SCOPE], "graphql-scope"],
    ["an unknown class", [UNKNOWN_CLASS], "collection-not-found"],
    ["an unknown aggregate class", [UNKNOWN_AGGREGATE], "collection-not-found"],
    ["the result limit", [LIMIT], "result-limit"],
    ["words no row reads", ['Syntax Error GraphQL request (1:3) Expected Name, found "}"'], "input"],
    ["two messages, the second read", ["first problem", TENANT_COLD], "tenant-not-active"],
  ] as const)("a 200 with errors in the documented shape naming %s is %s", (_what, messages, category) => {
    const failure = graphqlFailure(graphql(...messages));
    expect(failure?.category).toBe(category);
    expect(failure?.detail).toBe(messages.join("; "));
    expect(failure?.status).toBe(200);
    expect(failure?.retryAfter).toBeNull();
  });
});

describe("retryAfterSeconds: 1 to 9 digits, never echoed", () => {
  test.each([
    ["7", 7],
    ["0", 0],
    ["999999999", 999_999_999],
    ["007", 7],
  ] as const)("%s is %d s", (value, seconds) => {
    expect(retryAfterSeconds(value)).toBe(seconds);
  });

  test.each(["1234567890", "-5", "1.5", " 10", "10 ", "", "abc", "Sat, 03 Oct 2026 12:00:30 GMT", null])(
    "%j names no wait",
    (value) => {
      expect(retryAfterSeconds(value)).toBeUndefined();
    },
  );
});

describe("toProviderError: Studio's sentence first, the server's words after it", () => {
  test("the captured 401s are authentication errors with the server's words", () => {
    const noKey = worded(NO_KEY);
    expect(noKey).toBeInstanceOf(AuthenticationError);
    expect(noKey.message).toBe(
      "Weaviate refused the API key or token. (Weaviate: anonymous access not enabled. Please authenticate through one of the available methods: [API-keys])",
    );
    expect(String((noKey as AuthenticationError).provider)).toBe("weaviate");
    expect(worded(WRONG_KEY).message).toBe(
      "Weaviate refused the API key or token. (Weaviate: unauthorized: invalid api key)",
    );
  });

  test("a 403 in the documented shape is an authentication error at connect and a query error after it", () => {
    const connect = worded(handler(403, RBAC), { ...CONTEXT, phase: "connect", op: "meta" });
    expect(connect).toBeInstanceOf(AuthenticationError);
    expect(connect.message).toBe(`The credential is not allowed to read this server's meta. (Weaviate: ${RBAC})`);
    const request = worded(handler(403, RBAC));
    expect(request).toBeInstanceOf(QueryError);
    expect(request).not.toBeInstanceOf(AuthenticationError);
    expect(request.message).toBe(`The credential is not allowed to run this request. (Weaviate: ${RBAC})`);
  });

  test("the GraphQL scope refusal names the version where REST search serves, without the server's words", () => {
    const sentence =
      "This credential's role is scoped to some collections, and Weaviate allows GraphQL only to a role that may read every collection, so this server version (below 1.39.7, which serves REST search) cannot run the search for it.";
    for (const answer of [handler(403, SCOPE), graphql(SCOPE)]) {
      const error = toProviderError(graphqlFailure(answer) as WeaviateError, { ...CONTEXT, op: "graphql" });
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(sentence);
    }
  });

  test("a missing collection reads as missing or not visible, without the server's words", () => {
    for (const answer of [handler(404, NO_COLLECTION), handler(400, UNKNOWN_CLASS)]) {
      const error = worded(answer);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe("The collection does not exist or is not visible to this credential.");
    }
  });

  test("a router 404 in the documented shape says the server has no such route", () => {
    expect(worded(router(404, ROUTE_ABSENT)).message).toBe(
      `This Weaviate server has no such route. (Weaviate: ${ROUTE_ABSENT})`,
    );
  });

  test.each([
    ["collection", "The collection does not exist or is not visible to this credential."],
    ["shards", "The collection does not exist or is not visible to this credential."],
    ["tenants", "The collection does not exist or is not visible to this credential."],
    ["tenant", "The tenant does not exist in this collection."],
    ["alias", "The alias does not exist."],
    ["objects", "The collection does not exist or is not visible to this credential."],
    ["object", "No object has this id in this collection."],
    ["collection_nodes", "The collection does not exist or is not visible to this credential."],
    ["meta", "Weaviate found nothing at the name or id the request gives."],
    ["search_bm25", "Weaviate found nothing at the name or id the request gives."],
  ] as const)("a bodyless 404 to %s reads %j", (op: WeaviateOp, sentence) => {
    const error = worded(NO_OBJECT, { ...CONTEXT, op });
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(sentence);
  });

  test("a 404 with words carries them after the not-found sentence, whatever the operation", () => {
    expect(worded(handler(404, "tenant not found: tenantZ"), { ...CONTEXT, op: "tenant" }).message).toBe(
      "Weaviate found nothing at the name or id the request gives. (Weaviate: tenant not found: tenantZ)",
    );
  });

  test.each([
    [
      "a cold tenant",
      handler(422, TENANT_COLD),
      `The tenant is not active, and Studio does not activate a tenant by reading it. (Weaviate: ${TENANT_COLD})`,
    ],
    [
      "REST search behind its flag",
      handler(422, REST_FLAG),
      `This Weaviate server keeps its REST search behind EXPERIMENTAL_REST_SEARCH_ENABLED, and GraphQL is not available either. (Weaviate: ${REST_FLAG})`,
    ],
    [
      "GraphQL disabled",
      handler(422, GRAPHQL_OFF),
      `This Weaviate server has GraphQL disabled. (Weaviate: ${GRAPHQL_OFF})`,
    ],
    [
      "the result limit",
      handler(400, LIMIT),
      `The request asks for more objects than the server's QUERY_MAXIMUM_RESULTS. (Weaviate: ${LIMIT})`,
    ],
    [
      "an input refusal",
      handler(422, "invalid 'limit': must be positive"),
      "Weaviate did not accept the request as written. (Weaviate: invalid 'limit': must be positive)",
    ],
    [
      "a 500",
      handler(500, "an internal stand-in failure"),
      "Weaviate failed to run the request (HTTP 500). (Weaviate: an internal stand-in failure)",
    ],
    [
      "a 405",
      plain(405, "method not allowed"),
      "Weaviate answered HTTP 405, which Studio does not read. (Weaviate: method not allowed)",
    ],
    ["a bodyless 302", plain(302, ""), "Weaviate answered HTTP 302, which Studio does not read."],
  ] as const)("%s in the documented shape is a query error with its sentence", (_what, answer, sentence) => {
    const error = worded(answer);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(sentence);
  });

  test("the captured TLS 400 is a connection error asking for an SSL mode, naming the endpoint", () => {
    const error = worded(PLAIN_TO_TLS);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(
      "Weaviate at weaviate.test:8080 speaks TLS on this port, and the connection sent plain HTTP: choose an SSL mode under SSL / TLS.",
    );
    expect((error as ConnectionError).host).toBe("weaviate.test");
    expect((error as ConnectionError).port).toBe(8080);
  });

  test("an IPv6 endpoint is bracketed in a sentence", () => {
    expect(worded(PLAIN_TO_TLS, { ...CONTEXT, endpoint: { host: "fd00::5", port: 8443 } }).message).toStartWith(
      "Weaviate at [fd00::5]:8443 speaks TLS",
    );
  });

  test.each([
    ["7", "try again in 7 s"],
    ["0", "try again in 0 s"],
    ["1.5", "try again later"],
    ["Sat, 03 Oct 2026 12:00:30 GMT", "try again later"],
    [null, "try again later"],
  ] as const)("a 429 with Retry-After %j says %s, and never echoes the header", (header, wait) => {
    const error = worded(plain(429, "too many requests", header));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      `Weaviate rate-limited the request; ${wait}. It was not sent again. (Weaviate: too many requests)`,
    );
  });

  test("a 503 is a connection error naming the endpoint", () => {
    const error = worded(plain(503, "not ready"));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("Weaviate is not ready to serve the request (HTTP 503). (Weaviate: not ready)");
    expect((error as ConnectionError).host).toBe("weaviate.test");
    expect((error as ConnectionError).port).toBe(8080);
  });

  test("a server text longer than 2,000 characters is cut, and says so", () => {
    expect(worded(handler(500, "x".repeat(2500))).message).toBe(
      `Weaviate failed to run the request (HTTP 500). (Weaviate: ${"x".repeat(2000)} (cut))`,
    );
    expect(worded(handler(500, "x".repeat(2000))).message).toBe(
      `Weaviate failed to run the request (HTTP 500). (Weaviate: ${"x".repeat(2000)})`,
    );
  });
});

describe("an echoed secret is withheld whole wherever a server's words reach a sentence", () => {
  const echo = (secret: string) =>
    [
      plain(401, JSON.stringify({ code: 401, message: `unauthorized: invalid api key ${secret}` })),
      handler(403, `${RBAC} for key ${secret}`),
      router(404, `path /v1/${secret} was not found`),
      handler(404, `tenant not found: ${secret}`),
      handler(422, `${TENANT_COLD} ${secret}`),
      handler(422, `${REST_FLAG} ${secret}`),
      handler(422, `${GRAPHQL_OFF} ${secret}`),
      handler(400, `${LIMIT} ${secret}`),
      handler(400, `invalid ${secret}`),
      plain(429, `slow down ${secret}`, "3"),
      handler(500, `failure ${secret}`),
      plain(503, `not ready ${secret}`),
      plain(418, `teapot ${secret}`),
    ] as const;

  test.each([
    ...echo(TEST_PASSWORD).map((answer) => [TEST_PASSWORD, answer] as const),
    ...echo(Buffer.from(TEST_PASSWORD).toString("base64")).map((answer) => ["its base64", answer] as const),
  ])("an answer echoing %s: %j", (_form, answer) => {
    const message = worded(answer).message;
    expect(message).toContain(`(Weaviate: ${WITHHELD})`);
    for (const form of CONTEXT.secretForms) expect(message).not.toContain(form);
  });

  test("a GraphQL error echoing the secret is withheld too", () => {
    const failure = graphqlFailure(graphql(`${TENANT_COLD} ${TEST_PASSWORD}`)) as WeaviateError;
    expect(toProviderError(failure, CONTEXT).message).toBe(
      `The tenant is not active, and Studio does not activate a tenant by reading it. (Weaviate: ${WITHHELD})`,
    );
  });

  test("with no secret configured, the words are shown", () => {
    expect(worded(WRONG_KEY, { ...CONTEXT, secretForms: [] }).message).toContain(
      "(Weaviate: unauthorized: invalid api key)",
    );
  });
});

describe("toProviderError: a request that never completed", () => {
  const transport = (kind: TransportError["kind"], message: string, context = CONTEXT) =>
    toProviderError(new TransportError(kind, message), context);

  test("a deadline is a timeout naming the limit", () => {
    const error = transport("timeout", "The request did not finish within its time limit");
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("The request to Weaviate did not finish within 30000 ms, so Studio stopped waiting.");
    expect((error as TimeoutError).timeout).toBe(30_000);
  });

  test("a connect that never completed is a connection error in the transport's words", () => {
    const sentence =
      "No answer from weaviate.test:8080 after 10 seconds: check the address, the port and the network path.";
    const error = transport("unreachable", sentence);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(sentence);
    expect((error as ConnectionError).host).toBe("weaviate.test");
  });

  test("a cancel is a cancellation", () => {
    const error = transport("aborted", "The request was cancelled");
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The request to Weaviate was cancelled.");
  });

  test.each([
    [16 * 1024 * 1024, "16 MiB"],
    [3 * 1024, "3 KiB"],
    [1500, "1,500 bytes"],
  ] as const)("an answer past a %d-byte cap names the cap as %s", (responseCapBytes, cap) => {
    const error = transport("too-large", "The response exceeded its byte cap", { ...CONTEXT, responseCapBytes });
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      `Weaviate's answer is larger than the ${cap} Studio reads for one response, so it was not read. Ask for fewer objects, fewer properties, or no vectors.`,
    );
  });

  test("a redirect and an encoding are connection errors, and the transport's words pass the secret check", () => {
    const redirect = transport("redirect", "The server answered 302 to https://weaviate.test/login");
    expect(redirect).toBeInstanceOf(ConnectionError);
    expect(redirect.message).toBe(
      "Weaviate at weaviate.test:8080 answered with a redirect, which Studio never follows. The server answered 302 to https://weaviate.test/login",
    );
    expect(transport("redirect", `Location: /login?key=${TEST_PASSWORD}`).message).toBe(
      `Weaviate at weaviate.test:8080 answered with a redirect, which Studio never follows. ${WITHHELD}`,
    );
    const encoding = transport("encoding", "Unsupported content-encoding br");
    expect(encoding).toBeInstanceOf(ConnectionError);
    expect(encoding.message).toBe(
      "Weaviate at weaviate.test:8080 answered in an encoding Studio does not read. Unsupported content-encoding br",
    );
    expect(transport("encoding", `charset ${TEST_PASSWORD}`).message).toContain(WITHHELD);
  });

  test("a TLS failure and a lost answer are connection errors naming the endpoint", () => {
    const tls = transport("tls", "self-signed certificate in certificate chain");
    expect(tls).toBeInstanceOf(ConnectionError);
    expect(tls.message).toBe(
      "The TLS connection to Weaviate at weaviate.test:8080 failed: check the SSL mode, the CA and the client certificate under SSL / TLS. self-signed certificate in certificate chain",
    );
    const network = transport("network", "The request failed before a complete response arrived (ECONNRESET)");
    expect(network).toBeInstanceOf(ConnectionError);
    expect(network.message).toBe(
      "No complete answer arrived from Weaviate at weaviate.test:8080, and the request was not sent again. The request failed before a complete response arrived (ECONNRESET)",
    );
    expect((network as ConnectionError).port).toBe(8080);
  });

  test("a repository error raised before the wire is returned as it is", () => {
    const refusal = new QueryError("The request names an operation this client does not send.", "weaviate");
    expect(toProviderError(refusal, CONTEXT)).toBe(refusal);
    const config = new DatabaseConfigError("Invalid host", "weaviate");
    expect(toProviderError(config, CONTEXT)).toBe(config);
  });

  test("anything else is reported without its text", () => {
    for (const thrown of [new Error(`boom ${TEST_PASSWORD}`), new TypeError("x is undefined"), "a string", null]) {
      const error = toProviderError(thrown, CONTEXT);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe("The request to Weaviate failed in a way Studio does not recognise.");
    }
  });
});

describe("expectOk: the answer when it is a success, else its failure worded", () => {
  test("a success is returned as it is", () => {
    const answer = plain(200, '{"version":"1.40.2"}');
    expect(expectOk(answer, { ...CONTEXT, op: "meta" })).toBe(answer);
  });

  test("a REST operation reads the status alone, so a 200 holding an errors field is a success", () => {
    const answer = graphql(TENANT_COLD);
    expect(expectOk(answer, CONTEXT)).toBe(answer);
  });

  test("the graphql operation reads the errors of a 200", () => {
    expect(() => expectOk(graphql(TENANT_COLD), { ...CONTEXT, op: "graphql" })).toThrow(
      `The tenant is not active, and Studio does not activate a tenant by reading it. (Weaviate: ${TENANT_COLD})`,
    );
    const answer = plain(200, JSON.stringify({ data: { Get: { Article: [] } } }));
    expect(expectOk(answer, { ...CONTEXT, op: "graphql" })).toBe(answer);
  });

  test("a failure throws its worded error", () => {
    let thrown: unknown;
    try {
      expectOk(NO_KEY, { ...CONTEXT, phase: "connect", op: "meta" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthenticationError);
    expect((thrown as Error).message).toStartWith("Weaviate refused the API key or token.");
  });
});
