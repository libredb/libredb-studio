import { describe, expect, test } from "bun:test";
import { AuthenticationError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { NodeRequest } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { DEFAULT_DATABASE_ID, FIRESTORE_API_ORIGIN, LIMITS } from "@/lib/db/providers/document/firestore/constants";
import type { FirestoreAuth } from "@/lib/db/providers/document/firestore/credential-policy";
import {
  ERROR_SENTENCES,
  type ErrorContext,
  mapGoogleError,
  mapTransportFailure,
  readGoogleError,
} from "@/lib/db/providers/document/firestore/errors";
import type { GoogleCredentials } from "@/lib/db/providers/document/firestore/google-credentials";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import { buildRequest, type FirestoreRequest } from "@/lib/db/providers/document/firestore/requests";
import type { LaneKind } from "@/lib/db/providers/document/firestore/seams";
import {
  createFirestoreClient,
  FIRESTORE_TRANSPORT_SENTENCES as S,
  routingHeaders,
} from "@/lib/db/providers/document/firestore/transport";
import { type FirestoreAnswer, fakeSeams, held, jsonAnswer, tokenAnswer } from "../../../helpers/firestore-seams";

const target: FirestoreTarget = { projectId: "demo-p", databaseId: DEFAULT_DATABASE_ID };
const named: FirestoreTarget = { projectId: "demo-p", databaseId: "orders" };
const TOKEN = "ya29.a0AfB_byC-test-token_value.123";
const signal = new AbortController().signal;
const context: ErrorContext = { phase: "statement", credential: "authorized_user", target, surface: "console" };
const user: GoogleCredentials = {
  type: "authorized_user",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "user-secret-value",
  refreshToken: "1//refresh-token-value",
};
const google = (credentials: GoogleCredentials): Extract<FirestoreAuth, { mode: "google" }> => ({
  mode: "google",
  credentials,
});
const API = { scheme: "https", host: "firestore.googleapis.com", port: 443 } as const;

/** Token lanes answer a fresh token; API lanes answer through `api`. */
function routed(api: (request: NodeRequest) => ReturnType<FirestoreAnswer>, ttl = 3600): FirestoreAnswer {
  let issued = 0;
  return (request, lane: LaneKind) => (lane === "api" ? api(request) : tokenAnswer(`t${++issued}`, ttl));
}

function urlOf(request: FirestoreRequest, on: FirestoreTarget = target): string {
  const built = buildRequest(on, request);
  const query = new URLSearchParams(built.query.map(([name, value]) => [name, value])).toString();
  return `${FIRESTORE_API_ORIGIN}${built.path}${query === "" ? "" : `?${query}`}`;
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error("expected a rejection");
  return error;
}

/** Lets queued microtasks run, so a send's token refresh finishes and its request reaches the API lane. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn must wait for the one before it.
    await Promise.resolve();
  }
}

describe("firestore routingHeaders", () => {
  test("the default database names the project only; a named one adds its id", () => {
    expect(routingHeaders(target)).toEqual({
      "x-goog-request-params": "project_id=demo-p",
      "google-cloud-resource-prefix": "projects/demo-p/databases/(default)",
    });
    expect(routingHeaders(named)).toEqual({
      "x-goog-request-params": "project_id=demo-p&database_id=orders",
      "google-cloud-resource-prefix": "projects/demo-p/databases/orders",
    });
  });
});

describe("firestore transport API lanes", () => {
  test("a pasted token opens one API lane with the bearer, both routing headers and the lane guards", async () => {
    const seams = fakeSeams({ answer: () => jsonAnswer({ name: "projects/demo-p/databases/(default)" }) });
    const client = createFirestoreClient(target, google({ type: "access_token", token: TOKEN }), seams);
    expect(client.mode).toBe("google");
    expect(client.target).toBe(target);
    expect(await client.send({ kind: "database" }, { signal, context })).toEqual({
      name: "projects/demo-p/databases/(default)",
    });
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["api"]);
    expect(seams.lanes[0].options).toEqual({
      origin: API,
      tls: { rejectUnauthorized: true, identity: "firestore.googleapis.com" },
      maxSockets: 8,
      headers: { authorization: `Bearer ${TOKEN}`, ...routingHeaders(target) },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    const request = seams.lanes[0].requests[0];
    expect(request.method).toBe("GET");
    expect(request.url).toBe(urlOf({ kind: "database" }));
    expect(request.body).toBeUndefined();
    expect(request.maxResponseBytes).toBe(LIMITS.smallResponseBytes);
  });

  test("a named database sends its own routing headers", async () => {
    const seams = fakeSeams();
    await createFirestoreClient(named, google({ type: "access_token", token: TOKEN }), seams).send(
      { kind: "database" },
      { signal, context },
    );
    expect(seams.lanes[0].options.headers).toEqual({ authorization: `Bearer ${TOKEN}`, ...routingHeaders(named) });
  });

  test("an authorized user gets its token on a guarded token lane, and its quota project as x-goog-user-project", async () => {
    const plain = fakeSeams({ answer: routed(() => jsonAnswer({})) });
    await createFirestoreClient(target, google(user), plain).send({ kind: "database" }, { signal, context });
    expect(plain.lanes.map((lane) => lane.lane)).toEqual(["token", "api"]);
    expect(plain.lanesOf("token")[0].options).toEqual({
      origin: { scheme: "https", host: "oauth2.googleapis.com", port: 443 },
      tls: { rejectUnauthorized: true, identity: "oauth2.googleapis.com" },
      maxSockets: 1,
      headers: {},
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    expect(plain.lanesOf("api")[0].options.headers).toEqual({ authorization: "Bearer t1", ...routingHeaders(target) });
    const quota = fakeSeams({ answer: routed(() => jsonAnswer({})) });
    await createFirestoreClient(target, google({ ...user, quotaProjectId: "demo-quota-1" }), quota).send(
      { kind: "database" },
      { signal, context },
    );
    expect(quota.lanesOf("api")[0].options.headers).toEqual({
      authorization: "Bearer t1",
      ...routingHeaders(target),
      "x-goog-user-project": "demo-quota-1",
    });
  });

  test("the metadata lane is plain HTTP with the flavor header and no link-local refusal", async () => {
    const seams = fakeSeams({ answer: routed(() => jsonAnswer({})) });
    await createFirestoreClient(target, google({ type: "metadata", host: "meta.internal:8080" }), seams).send(
      { kind: "database" },
      { signal, context },
    );
    expect(seams.lanes.map((lane) => lane.lane)).toEqual(["metadata", "api"]);
    expect(seams.lanesOf("metadata")[0].options).toEqual({
      origin: { scheme: "http", host: "meta.internal", port: 8080 },
      tls: null,
      maxSockets: 1,
      headers: { "metadata-flavor": "Google" },
      refusesUpgrade: true,
    });
  });

  test("each bearer gets its own lane, and a replaced lane closes once its requests finish", async () => {
    const first = held<ReturnType<typeof jsonAnswer>>();
    let calls = 0;
    const seams = fakeSeams({ answer: routed(() => (++calls === 1 ? first.promise : jsonAnswer({ n: calls })), 30) });
    const client = createFirestoreClient(target, google(user), seams);
    const slow = client.send({ kind: "database" }, { signal, context });
    // Without this the second send would share the first send's single-flight refresh and get t1 too.
    await settle();
    expect(seams.lanesOf("api")).toHaveLength(1);
    expect(seams.lanesOf("api")[0].requests).toHaveLength(1);
    // t1 lives 30 seconds, already inside the 60-second early-refresh window, so this send refreshes to t2.
    expect(await client.send({ kind: "database" }, { signal, context })).toEqual({ n: 2 });
    expect(seams.lanesOf("api")).toHaveLength(2);
    const [old, fresh] = seams.lanesOf("api");
    expect(old.options.headers.authorization).toBe("Bearer t1");
    expect(fresh.options.headers.authorization).toBe("Bearer t2");
    expect(old.closed).toBe(0);
    first.resolve(jsonAnswer({ n: 1 }));
    expect(await slow).toEqual({ n: 1 });
    expect(old.closed).toBe(1);
    expect(fresh.closed).toBe(0);
  });

  test("a query posts the table's body under the large cap and returns the parsed stream", async () => {
    const request: FirestoreRequest = {
      kind: "runQuery",
      parent: [],
      body: { structuredQuery: { from: [{ collectionId: "users" }], limit: 100 } },
    };
    const stream = [{ document: { name: "projects/demo-p/databases/(default)/documents/users/a" } }];
    const seams = fakeSeams({ answer: () => jsonAnswer(stream) });
    const client = createFirestoreClient(target, google({ type: "access_token", token: TOKEN }), seams);
    expect(await client.send(request, { signal, context })).toEqual(stream);
    const sent = seams.lanes[0].requests[0];
    const built = buildRequest(target, request);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(urlOf(request));
    expect(sent.body).toBe(built.body);
    expect(sent.maxResponseBytes).toBe(LIMITS.largeResponseBytes);
  });

  test("a listing sends the table's query parameters", async () => {
    const request: FirestoreRequest = {
      kind: "listDocuments",
      parent: [],
      collectionId: "users",
      pageSize: 50,
      maskFieldPaths: ["__name__"],
    };
    const seams = fakeSeams({ answer: () => jsonAnswer({ documents: [] }) });
    await createFirestoreClient(target, google({ type: "access_token", token: TOKEN }), seams).send(request, {
      signal,
      context,
    });
    expect(seams.lanes[0].requests[0].url).toBe(urlOf(request));
    expect(seams.lanes[0].requests[0].maxResponseBytes).toBe(LIMITS.largeResponseBytes);
  });
});

describe("firestore transport refuses before any token or socket", () => {
  const forbidden = [
    { kind: "commit", body: { writes: [] } },
    { kind: "runQuery", parent: [], body: { structuredQuery: {}, transaction: "dHg=" } },
    { kind: "runQuery", parent: [], body: { structuredQuery: {}, newTransaction: { readOnly: {} } } },
    { kind: "runQuery", parent: [], body: { structuredQuery: {}, readTime: "2026-10-12T00:00:00Z" } },
    { kind: "runAggregationQuery", parent: [], body: { structuredAggregationQuery: {}, requestOptions: {} } },
    { kind: "batchGet", body: { documents: [], transaction: "dHg=" } },
    { kind: "batchGet", body: { documents: [], newTransaction: { readOnly: {} } } },
    { kind: "runQuery", parent: [], body: { structuredQuery: {}, recursive: true } },
    // The query-parameter route: a forbidden key on a GET request.
    { kind: "get", path: ["users", "a"], readTime: "2026-10-12T00:00:00Z" },
    { kind: "get", path: ["users", "a"], transaction: "dHg=" },
    { kind: "listDocuments", parent: [], collectionId: "users", readTime: "2026-10-12T00:00:00Z" },
    { kind: "listCollectionIds", parent: [], recursive: true },
  ] as unknown as readonly FirestoreRequest[];

  for (const request of forbidden) {
    test(`${JSON.stringify(request)} is refused by the closed table`, async () => {
      const seams = fakeSeams({ answer: routed(() => jsonAnswer({})) });
      const client = createFirestoreClient(target, google(user), seams);
      expect(await failureOf(client.send(request, { signal, context }))).toBeInstanceOf(QueryError);
      expect(seams.lanes).toEqual([]);
    });
  }
});

describe("firestore transport answers", () => {
  const client = (answer: FirestoreAnswer) => {
    const seams = fakeSeams({ answer });
    return { seams, client: createFirestoreClient(target, google({ type: "access_token", token: TOKEN }), seams) };
  };

  test("a non-2xx answer is Google's envelope mapped by the error table", async () => {
    const bodies = [
      [403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }],
      [404, { error: { code: 404, status: "NOT_FOUND", message: "Database not found." } }],
      [400, { error: { code: 400, status: "FAILED_PRECONDITION", message: "The query requires an index." } }],
      [503, "<html>unavailable</html>"],
    ] as const;
    for (const [status, body] of bodies) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const { client: firestore } = client(() => ({ status, contentType: "application/json", retryAfter: null, text }));
      // oxlint-disable-next-line no-await-in-loop -- each status gets its own client, checked in turn.
      const error = await failureOf(firestore.send({ kind: "database" }, { signal, context }));
      const expected = mapGoogleError(readGoogleError(status, text), context);
      expect(error.constructor).toBe(expected.constructor);
      expect(error.message).toBe(expected.message);
    }
  });

  test("299 is the last status read as an answer, and 300 is mapped like any other failure", async () => {
    const body = { name: "projects/demo-p/databases/(default)" };
    const { client: last } = client(() => jsonAnswer(body, 299));
    expect(await last.send({ kind: "database" }, { signal, context })).toEqual(body);
    const text = JSON.stringify(body);
    const { client: moved } = client(() => ({ status: 300, contentType: "application/json", retryAfter: null, text }));
    const error = await failureOf(moved.send({ kind: "database" }, { signal, context }));
    const expected = mapGoogleError(readGoogleError(300, text), context);
    expect(error.constructor).toBe(expected.constructor);
    expect(error.message).toBe(expected.message);
  });

  test("a 2xx stream that ends in an error element is that error, never a short answer", async () => {
    const request: FirestoreRequest = {
      kind: "runQuery",
      parent: [],
      body: { structuredQuery: { from: [{ collectionId: "users" }], limit: 100 } },
    };
    const read = {
      document: { name: "projects/demo-p/databases/(default)/documents/users/a" },
      readTime: "2026-10-12T00:00:00Z",
    };
    const { client: whole } = client(() => jsonAnswer([read]));
    expect(await whole.send(request, { signal, context })).toEqual([read]);
    const stream = [read, { error: { code: 504, status: "DEADLINE_EXCEEDED", message: "Deadline exceeded." } }];
    const { client: cut } = client(() => jsonAnswer(stream));
    const error = await failureOf(cut.send(request, { signal, context }));
    const expected = mapGoogleError(readGoogleError(200, JSON.stringify(stream)), context);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.constructor).toBe(expected.constructor);
    expect(error.message).toBe(expected.message);
    // A literal, not the error table's own output: Google's words reach the user.
    expect(error.message).toContain("Deadline exceeded (DEADLINE_EXCEEDED)");
  });

  // The transport hands the header to errors.ts as GoogleError.retryAfter; errors.ts writes "7" as "7s".
  test("a 429 without RetryInfo reports its Retry-After header as the retry delay", async () => {
    const text = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } });
    const { client: firestore } = client(() => jsonAnswer(JSON.parse(text), 429, "7"));
    const error = await failureOf(firestore.send({ kind: "database" }, { signal, context }));
    expect(error).toBeInstanceOf(QueryError);
    // A literal, not the error table's own output: a transport that drops the header fails here.
    expect(error.message).toContain("; retry after 7s");
    const dated = "Mon, 12 Oct 2026 10:00:00 GMT";
    const { client: second } = client(() => jsonAnswer(JSON.parse(text), 429, dated));
    expect((await failureOf(second.send({ kind: "database" }, { signal, context }))).message).toContain(
      `; retry after ${dated}`,
    );
    const { client: bare } = client(() => jsonAnswer(JSON.parse(text), 429));
    expect((await failureOf(bare.send({ kind: "database" }, { signal, context }))).message).not.toContain(
      "retry after",
    );
  });

  test("Google's RetryInfo delay wins over the Retry-After header", async () => {
    const text = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }],
      },
    });
    const { client: firestore } = client(() => jsonAnswer(JSON.parse(text), 429, "7"));
    const error = await failureOf(firestore.send({ kind: "database" }, { signal, context }));
    expect(error.message).toContain("; retry after 30s");
    expect(error.message).not.toContain("retry after 7");
  });

  test("a 2xx body that is not JSON is an explicit error", async () => {
    const { client: firestore } = client(() => ({
      status: 200,
      contentType: "text/html",
      retryAfter: null,
      text: "<html>",
    }));
    const error = await failureOf(firestore.send({ kind: "database" }, { signal, context }));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.notJson);
  });

  test("a transport failure is mapped with the call's context and its request kind", async () => {
    const thrown = new TransportError("too-large", "fake too large");
    const { client: firestore } = client(() => {
      throw thrown;
    });
    const error = await failureOf(firestore.send({ kind: "database" }, { signal, context }));
    const expected = mapTransportFailure(thrown, { ...context, requestKind: "database" });
    expect(error.constructor).toBe(expected.constructor);
    expect(error.message).toBe(expected.message);
  });

  test("a too-large document read answers the one-document sentence on the console too", async () => {
    const thrown = new TransportError("too-large", "fake too large");
    const { client: firestore } = client(() => {
      throw thrown;
    });
    // context.surface is "console": only the request kind the transport adds can pick the one-document sentence.
    const error = await failureOf(firestore.send({ kind: "get", path: ["users", "a"] }, { signal, context }));
    expect(error.message).toBe(`${ERROR_SENTENCES.documentTooLarge}.`);
  });

  test("a token endpoint refusal passes through untouched and opens no API lane", async () => {
    const seams = fakeSeams({
      answer: () =>
        jsonAnswer({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    });
    const error = await failureOf(
      createFirestoreClient(target, google(user), seams).send({ kind: "database" }, { signal, context }),
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe("Google token request failed: Token has been expired or revoked.");
    expect(seams.lanesOf("api")).toEqual([]);
  });

  test("close closes every API lane and the token lane", async () => {
    const seams = fakeSeams({ answer: routed(() => jsonAnswer({})) });
    const firestore = createFirestoreClient(target, google(user), seams);
    await firestore.send({ kind: "database" }, { signal, context });
    firestore.close();
    expect(seams.lanes.map((lane) => [lane.lane, lane.closed])).toEqual([
      ["token", 1],
      ["api", 1],
    ]);
  });
});
