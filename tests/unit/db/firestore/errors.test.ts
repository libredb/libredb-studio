/**
 * Google's error answers, transport failures and the database probe in the user's words (spec 8.1), each row with
 * its exact sentence and the rows' order proven where two could match.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { FIRESTORE_TYPE, type FirestoreTarget, SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import {
  databaseResourceRefusal,
  ERROR_SENTENCES as E,
  type ErrorContext,
  type GoogleError,
  googleErrorOf,
  mapGoogleError,
  mapTransportFailure,
  readGoogleError,
} from "@/lib/db/providers/document/firestore/errors";

const T: FirestoreTarget = { projectId: "demo-libredb", databaseId: "(default)" };
const STATEMENT: ErrorContext = { phase: "statement", credential: "service_account", target: T };
const CONNECT: ErrorContext = { ...STATEMENT, phase: "connect" };
const ACTIVATION =
  "https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=demo-libredb";

function mapped(error: GoogleError, context: ErrorContext): Error {
  const result = mapGoogleError(error, context);
  expect((result as QueryError).provider).toBe(FIRESTORE_TYPE);
  return result;
}

describe("readGoogleError", () => {
  test("reads status, message, reason and deduplicated https links from the envelope", () => {
    const text = JSON.stringify({
      error: {
        code: 403,
        message: "Cloud Firestore API has not been used in project demo-libredb before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            domain: "googleapis.com",
            metadata: { activationUrl: ACTIVATION, service: "firestore.googleapis.com" },
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [
              { description: "activation", url: ACTIVATION },
              { description: "plain", url: "http://example.com" },
              { description: "script", url: "javascript:alert(1)" },
            ],
          },
        ],
      },
    });
    expect(readGoogleError(403, text)).toEqual({
      httpStatus: 403,
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Cloud Firestore API has not been used in project demo-libredb before or it is disabled.",
      reason: "SERVICE_DISABLED",
      links: [ACTIVATION],
    });
  });

  test("reads the permission and the retry delay", () => {
    const text = JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" },
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "IAM_PERMISSION_DENIED",
            metadata: { permission: "datastore.entities.list" },
          },
        ],
      },
    });
    expect(readGoogleError(429, text)).toEqual({
      httpStatus: 429,
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded.",
      reason: "IAM_PERMISSION_DENIED",
      retryDelay: "30s",
      permission: "datastore.entities.list",
    });
  });

  test("reads the error element of a streamed answer", () => {
    const text = JSON.stringify([
      { readTime: "2026-10-12T00:00:00Z" },
      { error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } },
    ]);
    expect(readGoogleError(400, text)).toEqual({
      httpStatus: 400,
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "bad",
    });
    const late = JSON.stringify([
      { readTime: "x" },
      { error: { code: 403, status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } },
    ]);
    expect(readGoogleError(200, late)).toEqual({
      httpStatus: 200,
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Missing or insufficient permissions.",
    });
  });

  test("keeps only the status for a body that is not Google's envelope, and keeps a long message whole", () => {
    expect(readGoogleError(502, "<html>Bad Gateway</html>")).toEqual({ httpStatus: 502 });
    expect(readGoogleError(500, JSON.stringify({ error: "x" }))).toEqual({ httpStatus: 500 });
    expect(readGoogleError(500, JSON.stringify([{ done: true }]))).toEqual({ httpStatus: 500 });
    expect(readGoogleError(500, JSON.stringify({ error: { details: "x", status: 7, code: "403" } }))).toEqual({
      httpStatus: 500,
    });
    const long = readGoogleError(400, JSON.stringify({ error: { message: "m".repeat(5_000) } }));
    expect(long.message).toHaveLength(5_000);
  });
});

describe("mapGoogleError: the rows of spec 8.1 in order", () => {
  test("the emulator in Datastore mode, ahead of the 400 row", () => {
    const error: GoogleError = {
      httpStatus: 400,
      status: "FAILED_PRECONDITION",
      message: "Database mode not set to Firestore Mode.",
    };
    const result = mapped(error, { ...CONNECT, credential: "emulator" });
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(result.message).toBe(
      "Database mode not set to Firestore Mode (FAILED_PRECONDITION). The Firestore emulator was started in Datastore mode; start it in Firestore mode and connect again.",
    );
    const elsewhere = mapped(error, CONNECT);
    expect(elsewhere).toBeInstanceOf(QueryError);
    expect(elsewhere.message).toBe("Database mode not set to Firestore Mode (FAILED_PRECONDITION).");
  });

  test("404 on connect names both ids; 404 after connect is Google's message", () => {
    const error: GoogleError = {
      httpStatus: 404,
      status: "NOT_FOUND",
      message: "The database (default) does not exist for project demo-libredb",
    };
    const onConnect = mapped(error, CONNECT);
    expect(onConnect).toBeInstanceOf(DatabaseConfigError);
    expect(onConnect.message).toBe(
      'The database (default) does not exist for project demo-libredb (NOT_FOUND). Google found no Firestore database "(default)" in project "demo-libredb"; check the Project ID and Database ID fields.',
    );
    const later = mapped(error, STATEMENT);
    expect(later).toBeInstanceOf(QueryError);
    expect(later.message).toBe("The database (default) does not exist for project demo-libredb (NOT_FOUND).");
  });

  test("401 with a pasted access token, and 401 otherwise", () => {
    const error: GoogleError = {
      httpStatus: 401,
      status: "UNAUTHENTICATED",
      message: "Request had invalid authentication credentials.",
    };
    const token = mapped(error, { ...STATEMENT, credential: "access_token" });
    expect(token).toBeInstanceOf(AuthenticationError);
    expect(token.message).toBe(
      "Request had invalid authentication credentials (UNAUTHENTICATED). The pasted access token was refused; tokens from gcloud auth print-access-token last about an hour: paste a new one, or use a service-account key.",
    );
    const key = mapped(error, CONNECT);
    expect(key).toBeInstanceOf(AuthenticationError);
    expect(key.message).toBe(
      "Request had invalid authentication credentials (UNAUTHENTICATED). Google refused the credential; check that it is current and that its principal can reach this project.",
    );
  });

  test("403 SERVICE_DISABLED carries the activation link, on connect and after it", () => {
    const text = JSON.stringify({
      error: {
        message: "Cloud Firestore API has not been used in project demo-libredb before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: { activationUrl: ACTIVATION },
          },
        ],
      },
    });
    const expected = `Cloud Firestore API has not been used in project demo-libredb before or it is disabled (SERVICE_DISABLED). The Firestore API is disabled on project "demo-libredb"; enable it at ${ACTIVATION} and connect again.`;
    for (const context of [CONNECT, STATEMENT]) {
      const result = mapped(readGoogleError(403, text), context);
      expect(result).toBeInstanceOf(DatabaseConfigError);
      expect(result.message).toBe(expected);
    }
    expect(mapped({ httpStatus: 403, reason: "SERVICE_DISABLED", message: "Disabled." }, CONNECT).message).toBe(
      'Disabled (SERVICE_DISABLED). The Firestore API is disabled on project "demo-libredb"; enable it and connect again.',
    );
  });

  test("403 for a missing quota project", () => {
    const sentence = E.quotaProject("demo-libredb");
    expect(sentence).toBe(
      "This authorized-user credential needs a quota project: run gcloud auth application-default set-quota-project demo-libredb, then paste the file again",
    );
    const denied = mapped(
      {
        httpStatus: 403,
        reason: "USER_PROJECT_DENIED",
        message: "Caller does not have required permission to use project.",
      },
      STATEMENT,
    );
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect(denied.message).toBe(
      `Caller does not have required permission to use project (USER_PROJECT_DENIED). ${sentence}.`,
    );
    const message = "The firestore.googleapis.com API requires a quota project, which is not set by default.";
    const adc = mapped(
      { httpStatus: 403, status: "PERMISSION_DENIED", message },
      { ...CONNECT, credential: "authorized_user" },
    );
    expect(adc).toBeInstanceOf(AuthenticationError);
    expect(adc.message).toBe(`${message.slice(0, -1)} (PERMISSION_DENIED). ${sentence}.`);
    const key = mapped({ httpStatus: 403, status: "PERMISSION_DENIED", message }, CONNECT);
    expect(key.message).not.toContain("set-quota-project");
  });

  test("403 names the permission: AuthenticationError on connect, QueryError after it", () => {
    const fromMetadata: GoogleError = {
      httpStatus: 403,
      status: "PERMISSION_DENIED",
      reason: "IAM_PERMISSION_DENIED",
      message: "Permission denied on resource project demo-libredb.",
      permission: "datastore.entities.list",
    };
    const onConnect = mapped(fromMetadata, CONNECT);
    expect(onConnect).toBeInstanceOf(AuthenticationError);
    expect(onConnect.message).toBe(
      "Permission denied on resource project demo-libredb (IAM_PERMISSION_DENIED). The credential lacks the Firestore permission datastore.entities.list; grant its principal roles/datastore.viewer, which holds every permission Studio's reads need.",
    );
    const fromMessage = mapped(
      {
        httpStatus: 403,
        status: "PERMISSION_DENIED",
        message: "Permission 'datastore.entities.get' denied on resource.",
      },
      STATEMENT,
    );
    expect(fromMessage).toBeInstanceOf(QueryError);
    expect(fromMessage.message).toContain("lacks the Firestore permission datastore.entities.get;");
    const unnamed = mapped(
      { httpStatus: 403, status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." },
      { ...STATEMENT, phase: "listing" },
    );
    expect(unnamed).toBeInstanceOf(QueryError);
    expect(unnamed.message).toBe(
      "Missing or insufficient permissions (PERMISSION_DENIED). The credential lacks a Firestore permission this read needs; grant its principal roles/datastore.viewer, which holds every permission Studio's reads need.",
    );
  });

  test("400 passes Google's message through, index link included", () => {
    const link = "https://console.firebase.google.com/v1/r/project/demo-libredb/firestore/indexes?create_composite=Cl";
    const precondition = mapped(
      {
        httpStatus: 400,
        status: "FAILED_PRECONDITION",
        message: `The query requires an index. You can create it here: ${link}`,
      },
      STATEMENT,
    );
    expect(precondition).toBeInstanceOf(QueryError);
    expect(precondition.message).toBe(
      `The query requires an index. You can create it here: ${link} (FAILED_PRECONDITION).`,
    );
    const invalid = mapped({ httpStatus: 400, status: "INVALID_ARGUMENT", message: "limit is negative." }, STATEMENT);
    expect(invalid.message).toBe("limit is negative (INVALID_ARGUMENT).");
  });

  test("429 with and without a retry delay", () => {
    expect(
      mapped(
        { httpStatus: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded.", retryDelay: "30s" },
        STATEMENT,
      ).message,
    ).toBe(
      "Quota exceeded (RESOURCE_EXHAUSTED). Firestore's quota or rate limit for this project is exhausted; retry after 30s.",
    );
    expect(
      mapped({ httpStatus: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded.", retryAfter: "7" }, STATEMENT)
        .message,
    ).toBe(
      "Quota exceeded (RESOURCE_EXHAUSTED). Firestore's quota or rate limit for this project is exhausted; retry after 7s.",
    );
    expect(
      mapped({ httpStatus: 429, message: "Quota exceeded.", retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT" }, STATEMENT)
        .message,
    ).toBe(
      "Quota exceeded. Firestore's quota or rate limit for this project is exhausted; retry after Wed, 21 Oct 2026 07:28:00 GMT.",
    );
    expect(
      mapped({ httpStatus: 429, message: "Quota exceeded.", retryDelay: "30s", retryAfter: "7" }, STATEMENT).message,
    ).toContain("retry after 30s.");
    const bare = mapped({ httpStatus: 429 }, STATEMENT);
    expect(bare).toBeInstanceOf(QueryError);
    expect(bare.message).toBe(
      "Firestore answered HTTP 429. Firestore's quota or rate limit for this project is exhausted.",
    );
  });

  test("DEADLINE_EXCEEDED is a TimeoutError, with the aggregation sentence for an aggregation", () => {
    const error: GoogleError = { httpStatus: 504, status: "DEADLINE_EXCEEDED", message: "Deadline exceeded." };
    const plain = mapped(error, STATEMENT);
    expect(plain).toBeInstanceOf(TimeoutError);
    expect(plain.message).toBe(
      "Deadline exceeded (DEADLINE_EXCEEDED). The statement ran past the connection's query timeout.",
    );
    expect(mapped(error, { ...STATEMENT, aggregation: true }).message).toBe(
      "Deadline exceeded (DEADLINE_EXCEEDED). The statement ran past the connection's query timeout. Firestore stops an aggregation at 60 seconds.",
    );
  });

  test("5xx and any other status: status and Google's message, never twice", () => {
    const unavailable = mapped(
      { httpStatus: 503, status: "UNAVAILABLE", message: "The service is currently unavailable." },
      STATEMENT,
    );
    expect(unavailable).toBeInstanceOf(QueryError);
    expect(unavailable.message).toBe(
      "The service is currently unavailable (UNAVAILABLE). Firestore answered HTTP 503.",
    );
    expect(mapped({ httpStatus: 502 }, STATEMENT).message).toBe("Firestore answered HTTP 502.");
    expect(mapped({ httpStatus: 409, status: "ABORTED", message: "  " }, STATEMENT).message).toBe(
      "Firestore answered HTTP 409 (ABORTED).",
    );
  });

  test("an error element at the end of a 2xx stream is mapped by its own code", () => {
    const stream = (code: number, status: string, message: string): string =>
      JSON.stringify([{ readTime: "2026-10-12T00:00:00Z" }, { error: { code, status, message } }]);
    const denied = mapped(
      readGoogleError(200, stream(403, "PERMISSION_DENIED", "Missing or insufficient permissions.")),
      STATEMENT,
    );
    expect(denied).toBeInstanceOf(QueryError);
    expect(denied.message).toBe(
      "Missing or insufficient permissions (PERMISSION_DENIED). The credential lacks a Firestore permission this read needs; grant its principal roles/datastore.viewer, which holds every permission Studio's reads need.",
    );
    expect(
      mapped(readGoogleError(200, stream(403, "PERMISSION_DENIED", "Missing or insufficient permissions.")), CONNECT),
    ).toBeInstanceOf(AuthenticationError);
    expect(
      mapped(readGoogleError(200, stream(504, "DEADLINE_EXCEEDED", "Deadline exceeded.")), STATEMENT),
    ).toBeInstanceOf(TimeoutError);
    expect(mapped({ httpStatus: 200, code: 503 }, STATEMENT).message).toBe("Firestore answered HTTP 503.");
    expect(mapped({ httpStatus: 500, code: 403, message: "x" }, STATEMENT).message).toBe(
      "x. Firestore answered HTTP 500.",
    );
  });

  test("a long message is cut to 2,000 characters in the sentence", () => {
    const long = readGoogleError(400, JSON.stringify({ error: { message: "m".repeat(5_000) } }));
    expect(mapped(long, STATEMENT).message).toBe(`${"m".repeat(2_000)}.`);
  });

  test("the cut never splits an astral character that straddles it", () => {
    const astral = String.fromCodePoint(0x1f600);
    const straddling = readGoogleError(
      400,
      JSON.stringify({ error: { message: `${"m".repeat(1_999)}${astral}tail` } }),
    );
    const message = mapped(straddling, STATEMENT).message;
    expect(message).toBe(`${"m".repeat(1_999)}.`);
    expect(message.isWellFormed()).toBe(true);
  });

  test("a secret form that straddles the cut is still withheld", () => {
    const result = mapped(
      { httpStatus: 401, status: "UNAUTHENTICATED", message: `${"m".repeat(1_995)}ya29.secret-token` },
      { ...STATEMENT, credential: "access_token", secretForms: ["ya29.secret-token"] },
    );
    expect(result.message).not.toContain("ya29.s");
    expect(
      result.message.startsWith("Google's message was withheld because it quotes the credential (UNAUTHENTICATED)."),
    ).toBe(true);
  });

  test("a message quoting a secret form is withheld", () => {
    const result = mapped(
      { httpStatus: 401, status: "UNAUTHENTICATED", message: "Token ya29.secret-token is invalid." },
      { ...STATEMENT, credential: "access_token", secretForms: ["", "ya29.secret-token"] },
    );
    expect(result.message).not.toContain("ya29.secret-token");
    expect(
      result.message.startsWith("Google's message was withheld because it quotes the credential (UNAUTHENTICATED)."),
    ).toBe(true);
  });
});

describe("googleErrorOf", () => {
  test("answers the Google error a mapped error was read from, whatever row produced it", () => {
    const read = readGoogleError(
      400,
      JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad page token" } }),
    );
    const invalid = mapGoogleError(read, STATEMENT);
    expect(googleErrorOf(invalid)).toBe(read);
    expect(googleErrorOf(invalid)).toEqual({
      httpStatus: 400,
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "bad page token",
    });
    const missing: GoogleError = { httpStatus: 404, status: "NOT_FOUND", message: "Document not found." };
    expect(googleErrorOf(mapGoogleError(missing, CONNECT))).toBe(missing);
    expect(googleErrorOf(mapGoogleError(missing, STATEMENT))?.httpStatus).toBe(404);
  });

  test("answers nothing for any value mapGoogleError did not return", () => {
    expect(googleErrorOf(new QueryError("x"))).toBeUndefined();
    expect(googleErrorOf(mapTransportFailure(new TransportError("timeout", "timed out"), STATEMENT))).toBeUndefined();
    expect(googleErrorOf(databaseResourceRefusal(null))).toBeUndefined();
    expect(googleErrorOf("text")).toBeUndefined();
    expect(googleErrorOf(undefined)).toBeUndefined();
  });
});

describe("mapTransportFailure", () => {
  test("a timeout is a TimeoutError", () => {
    const plain = mapTransportFailure(new TransportError("timeout", "timed out"), STATEMENT);
    expect(plain).toBeInstanceOf(TimeoutError);
    expect(plain.message).toBe("The statement ran past the connection's query timeout.");
    expect(
      mapTransportFailure(new TransportError("timeout", "timed out"), { ...STATEMENT, aggregation: true }).message,
    ).toBe("The statement ran past the connection's query timeout. Firestore stops an aggregation at 60 seconds.");
  });

  test("too-large answers its surface's sentence", () => {
    const keys = mapTransportFailure(new TransportError("too-large", "too large"), {
      ...STATEMENT,
      phase: "listing",
      surface: "keys",
    });
    expect(keys).toBeInstanceOf(QueryError);
    expect(keys.message).toBe(
      "These documents are too large to list this many at a time; list the level with a smaller count.",
    );
    const statement = mapTransportFailure(new TransportError("too-large", "too large"), {
      ...STATEMENT,
      surface: "console",
    });
    expect(statement.message).toBe(
      "Firestore's answer passed Studio's size cap for this request; ask for fewer documents with a smaller .limit(n), or for fewer fields with .select(...).",
    );
    const one =
      "This document's answer passed Studio's 4 MiB cap for a single document read, so Studio cannot show it.";
    const tooLarge = new TransportError("too-large", "too large");
    expect(mapTransportFailure(tooLarge, { ...STATEMENT, surface: "source", requestKind: "get" }).message).toBe(one);
    expect(mapTransportFailure(tooLarge, { ...STATEMENT, surface: "source" }).message).toBe(one);
    expect(mapTransportFailure(tooLarge, { ...STATEMENT, surface: "console", requestKind: "get" }).message).toBe(one);
    expect(
      mapTransportFailure(tooLarge, { ...STATEMENT, surface: "tree", requestKind: "listCollectionIds" }).message,
    ).toBe(`${SENTENCES.answerTooLarge}.`);
    expect(mapTransportFailure(tooLarge, { ...STATEMENT, surface: "console", requestKind: "runQuery" }).message).toBe(
      `${SENTENCES.answerTooLarge}.`,
    );
  });

  test("an abort is a cancellation; every other transport failure and every Studio error pass through", () => {
    const aborted = mapTransportFailure(new TransportError("aborted", "aborted"), STATEMENT);
    expect(aborted).toBeInstanceOf(QueryCancelledError);
    expect(aborted.message).toBe("The Firestore request was cancelled.");
    const unreachable = new TransportError("unreachable", "Could not reach firestore.googleapis.com");
    expect(mapTransportFailure(unreachable, STATEMENT)).toBe(unreachable);
    const query = new QueryError("x");
    expect(mapTransportFailure(query, STATEMENT)).toBe(query);
    const plain = mapTransportFailure("boom", STATEMENT);
    expect(plain).toBeInstanceOf(Error);
    expect(plain.message).toBe("boom");
  });
});

describe("databaseResourceRefusal (the probe rows)", () => {
  test("Datastore mode and disabled data access are refused; a Firestore database is not", () => {
    const datastore = databaseResourceRefusal({
      name: "projects/demo-libredb/databases/(default)",
      type: "DATASTORE_MODE",
    });
    expect(datastore).toBeInstanceOf(DatabaseConfigError);
    expect(datastore?.message).toBe("This database is in Datastore mode, which the Firestore API does not serve.");
    expect(
      databaseResourceRefusal({ type: "FIRESTORE_NATIVE", firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED" })
        ?.message,
    ).toBe(
      "Firestore API access is off on this database; turn it on or connect through its MongoDB-compatible endpoint with the MongoDB connection type.",
    );
    expect(
      databaseResourceRefusal({ type: "FIRESTORE_NATIVE", firestoreDataAccessMode: "DATA_ACCESS_MODE_ENABLED" }),
    ).toBeNull();
    expect(databaseResourceRefusal({ type: "FIRESTORE_NATIVE" })).toBeNull();
  });

  test("a probe body that is not an object is an explicit error", () => {
    expect(databaseResourceRefusal([])?.message).toBe(`${E.probeUnreadable}.`);
    expect(databaseResourceRefusal(null)).toBeInstanceOf(DatabaseConfigError);
  });
});
