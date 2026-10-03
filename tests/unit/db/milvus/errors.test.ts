/**
 * The Milvus error table (vector-family spec 5.10, E6, E7, E13, E14, E20). This file pins the adapter's half: how a
 * grpc-js status, a runtime error, the call's own abort and a common.Status are classified. Texts are the ones the
 * research measured (R09 section 8, R41, R42 M12), so a classification that drifts from what the server and the
 * runtimes say fails here; the captured answers are classified again in milvus-fixtures.test.ts. It pins the
 * provider's half too: each category's sentence and class, and that no form of the credential reaches a sentence.
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
import { secretForms } from "@/lib/db/utils/server-text";
import { MilvusError, type WireStatus } from "@/lib/db/providers/vector/milvus/client";
import {
  isReceiveCapError,
  type MilvusErrorContext,
  MilvusUnsentStatus,
  statusFailure,
  toMilvusError,
  toProviderError,
  unsupportedDataTypeError,
} from "@/lib/db/providers/vector/milvus/errors";

/** A grpc-js status error as the library rejects a call: `code`, `details`, `metadata`, and a message. */
function grpcError(code: number | undefined, details: string | undefined): Error {
  return Object.assign(new Error(`${code} ${details}`), { code, details, metadata: {} });
}

function status(code: number, errorCode: string, reason: string, detail = reason): WireStatus {
  return { code, error_code: errorCode, reason, detail, retriable: false, extra_info: {} };
}

const LAST = "No connection established. Last error: ";

describe("toMilvusError: gRPC codes (5.10)", () => {
  test.each([
    [16, "auth check failure, please check username and password are correct", "unauthenticated"],
    [7, "PrivilegeQuery: permission deny to nobody in the `default` database", "permission-denied"],
    [12, "method ListNamespaces not implemented", "unimplemented"],
    [14, "Connection dropped", "connection-dropped"],
    [14, "Received RST_STREAM with code 2", "unavailable"],
    [4, "Deadline exceeded after 3.001s,remote_addr=127.0.0.1:19530", "deadline-exceeded"],
    [1, "Call cancelled", "deadline-exceeded"],
    [2, "something else", "unknown"],
  ] as const)("code %d %j is %s", (code, details, category) => {
    const error = toMilvusError(grpcError(code, details));
    expect({ category: error.category, grpcCode: error.grpcCode, detail: error.detail }).toEqual({
      category,
      grpcCode: code,
      detail: details,
    });
  });

  test("RESOURCE_EXHAUSTED is read by its text alone (E13, E20, Review Focus 5)", () => {
    expect(toMilvusError(grpcError(8, "Received message larger than max (17825792 vs 16777216)")).category).toBe(
      "receive-cap",
    );
    expect(
      toMilvusError(grpcError(8, "Received message that decompresses to a size larger than 16777216")).category,
    ).toBe("receive-cap");
    expect(toMilvusError(grpcError(8, "Bandwidth exhausted or memory limit exceeded")).category).toBe("ping-goaway");
    expect(toMilvusError(grpcError(8, "rate limit exceeded")).category).toBe("unknown");
  });

  test("only the two cap texts are the receive cap, which part C's halved retry keys on", () => {
    expect(isReceiveCapError(toMilvusError(grpcError(8, "Received message larger than max (5 vs 4)")))).toBe(true);
    expect(isReceiveCapError(toMilvusError(grpcError(8, "Bandwidth exhausted or memory limit exceeded")))).toBe(false);
    expect(isReceiveCapError(new Error("Received message larger than max"))).toBe(false);
  });

  test("a ServiceError whose code is not a number is a transport failure (E13, R41 F12)", () => {
    const error = toMilvusError(grpcError(undefined, undefined));
    expect(error.category).toBe("transport");
    expect(error.detail).toBe("undefined undefined");
  });

  test("a deadline before any stream is a failure to connect; one after the send is a deadline", () => {
    expect(
      toMilvusError(grpcError(4, "Deadline exceeded after 2.0s,LB pick: 0.001s,Waiting for LB pick")).category,
    ).toBe("not-connected");
    expect(
      toMilvusError(grpcError(4, "Deadline exceeded after 2.0s,Waiting for LB pick,remote_addr=127.0.0.1:1")).category,
    ).toBe("deadline-exceeded");
  });

  test("unstarted answers: a name that does not resolve, and a call the close found waiting", () => {
    expect(toMilvusError(grpcError(14, "Name resolution failed for target dns:unix:19530")).category).toBe(
      "not-connected",
    );
    expect(toMilvusError(grpcError(14, "Channel closed before call started")).category).toBe("closed");
    expect(toMilvusError(grpcError(14, `${LAST}connect ECONNREFUSED 127.0.0.1:19530`)).category).toBe("not-connected");
    expect(toMilvusError(grpcError(14, `${LAST}Failed to connect (2026-10-03T00:41:38.451Z)`)).category).toBe(
      "not-connected",
    );
  });

  test.each([
    [
      "tlsv13 alert certificate required:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 116",
      "client-certificate-required",
    ],
    [
      "tlsv1 alert unknown ca:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 48",
      "client-certificate-refused",
    ],
    [
      "ssl/tls alert bad certificate:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 42",
      "client-certificate-refused",
    ],
    [
      "ssl/tls alert certificate expired:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 45",
      "client-certificate-expired",
    ],
    ["Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the cert's list: 10.0.0.5", "name"],
    [
      "Error: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca.",
      "chain",
    ],
    ["self signed certificate", "chain"],
    ["wrong version number", "not-tls"],
    ["WRONG_VERSION_NUMBER", "not-tls"],
  ] as const)("TLS cause %j is %s (E6, R42 F7)", (cause, failure) => {
    const error = toMilvusError(grpcError(14, `${LAST}${cause}`));
    expect({ category: error.category, tlsFailure: error.tlsFailure }).toEqual({
      category: "tls",
      tlsFailure: failure,
    });
  });

  test("a TLS failure of no named part is tls with no failure named", () => {
    const error = toMilvusError(grpcError(14, `${LAST}certificate has expired`));
    expect(error.category).toBe("tls");
    expect(Object.hasOwn(error, "tlsFailure")).toBe(false);
  });
});

describe("toMilvusError: the call's own signal (E14)", () => {
  test("a cancel the caller asked for is cancelled, a timeout is a deadline", () => {
    const cancel = new AbortController();
    cancel.abort();
    expect(toMilvusError(grpcError(1, "Cancelled on client"), cancel.signal).category).toBe("cancelled");
    const timeout = new AbortController();
    timeout.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(toMilvusError(grpcError(1, "Cancelled on client"), timeout.signal).category).toBe("deadline-exceeded");
    expect(toMilvusError(timeout.signal.reason, timeout.signal).category).toBe("deadline-exceeded");
  });

  test("a timeout that ended a call grpc-js never gave a transport is a failure to connect", () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const unsent = new MilvusUnsentStatus({
      code: 1,
      details: "Cancelled on client",
      message: "1 CANCELLED: Cancelled on client",
    });
    expect(toMilvusError(unsent, timeout.signal).category).toBe("not-connected");
  });

  test("a MilvusError passes through unchanged", () => {
    const error = new MilvusError("closed", "The client is closed");
    expect(toMilvusError(error)).toBe(error);
  });
});

describe("toMilvusError: runtime errors", () => {
  test("a system code names the code alone, never the address", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19530"), { code: "ECONNREFUSED" });
    expect(toMilvusError(refused)).toMatchObject({ category: "not-connected", detail: "ECONNREFUSED" });
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(toMilvusError(reset)).toMatchObject({ category: "unavailable", detail: "ECONNRESET" });
    const altname = Object.assign(new Error("Hostname mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(toMilvusError(altname)).toMatchObject({ category: "tls", tlsFailure: "name" });
    const other = Object.assign(new Error("something odd"), { code: "EWHATEVER" });
    expect(toMilvusError(other)).toMatchObject({ category: "unknown", detail: "EWHATEVER: something odd" });
  });

  test("anything else is unknown with its message", () => {
    expect(toMilvusError(new Error("boom"))).toMatchObject({ category: "unknown", detail: "boom" });
    expect(toMilvusError("text")).toMatchObject({ category: "unknown", detail: "text" });
  });
});

describe("statusFailure: every common.Status is checked (E20)", () => {
  test("success is code 0 and Success together", () => {
    expect(statusFailure(status(0, "Success", ""), "Query")).toBeUndefined();
  });

  test("code 0 with CollectionNotExists, as 2.6.25 answers, is a failure", () => {
    expect(statusFailure(status(0, "CollectionNotExists", "collection not found"), "DescribeCollection")).toMatchObject(
      {
        category: "status",
        status: { code: 0, errorCode: "CollectionNotExists" },
        detail: "collection not found",
      },
    );
  });

  test("a non-zero status inside a successful RPC is a failure, with its reason, or its detail when the reason is empty", () => {
    expect(
      statusFailure(status(101, "UnexpectedError", "failed to query: collection not loaded"), "Query"),
    ).toMatchObject({
      category: "status",
      status: { code: 101, errorCode: "UnexpectedError" },
      detail: "failed to query: collection not loaded",
    });
    expect(statusFailure(status(800, "UnexpectedError", "", "database not found"), "ShowCollections")?.detail).toBe(
      "database not found",
    );
  });

  test("a 10001 holding context deadline exceeded is the deadline's third shape (R41 F7)", () => {
    expect(
      statusFailure(
        status(10001, "UnexpectedError", "proxy TaskCondition context Done: context deadline exceeded"),
        "Query",
      )?.category,
    ).toBe("deadline-exceeded");
    expect(statusFailure(status(10001, "UnexpectedError", "something else"), "Query")?.category).toBe("status");
  });

  test("an answer with no status is malformed, naming the RPC", () => {
    expect(statusFailure(null, "GetVersion")).toMatchObject({
      category: "malformed",
      detail: "Milvus answered GetVersion with no status",
    });
    expect(statusFailure(undefined, "Query")?.category).toBe("malformed");
  });
});

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in. Not "password", which
// the server's 16 text and Studio's own sentence hold as a word, so every sentence would read as an echo.
const TEST_PASSWORD = "password-second";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";
const FORMS = secretForms([TEST_PASSWORD, `root:${TEST_PASSWORD}`]);

function context(overrides: Partial<MilvusErrorContext> = {}): MilvusErrorContext {
  return {
    operation: "query",
    write: false,
    database: "default",
    collection: "docs_int64",
    connection: {
      host: "milvus.test",
      port: 19530,
      runtimeReportsTlsCause: true,
      receiveCapBytes: 16 * 1024 * 1024,
      timeoutMs: 30_000,
    },
    secretForms: FORMS,
    ...overrides,
  };
}

const mapped = (error: MilvusError, overrides: Partial<MilvusErrorContext> = {}) =>
  toProviderError(error, context(overrides));

describe("toProviderError: Studio's sentence first, Milvus's text after (5.10)", () => {
  test("16 is an AuthenticationError naming the user name or password, with the server's text", () => {
    const error = mapped(
      new MilvusError("unauthenticated", "auth check failure, please check username and password are correct"),
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(
      "Milvus refused the user name or password (or token). (Milvus: auth check failure, please check username and password are correct)",
    );
  });

  test("7 names the privilege the server's text names", () => {
    const error = mapped(
      new MilvusError("permission-denied", "PrivilegeQuery: permission deny to nobody in the `default` database"),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The Milvus user lacks the privilege for the query. (Milvus: PrivilegeQuery: permission deny to nobody in the `default` database)",
    );
  });

  test("a dropped connection, a ping GOAWAY and a transport failure are connection errors, never retried", () => {
    expect(mapped(new MilvusError("connection-dropped", "Connection dropped")).message).toBe(
      "The connection to Milvus was lost; run it again. (Connection dropped)",
    );
    expect(mapped(new MilvusError("ping-goaway", "Bandwidth exhausted or memory limit exceeded")).message).toBe(
      "The Milvus server dropped the connection (a keepalive GOAWAY); run it again. (Bandwidth exhausted or memory limit exceeded)",
    );
    const transport = mapped(new MilvusError("transport", "undefined undefined"));
    expect(transport).toBeInstanceOf(ConnectionError);
    expect(transport.message).toBe("A transport failure ended the query at milvus.test:19530.");
  });

  test("the three deadline shapes all read as the deadline of the call class", () => {
    for (const detail of [
      "Deadline exceeded",
      "Call cancelled",
      "proxy TaskCondition context Done: context deadline exceeded",
    ]) {
      const error = mapped(new MilvusError("deadline-exceeded", detail));
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toBe(`The query reached its deadline of 30,000 ms. (${detail})`);
    }
  });

  test("a cancel the caller asked for is a QueryCancelledError", () => {
    const error = mapped(new MilvusError("cancelled", "Cancelled on client"));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The query was cancelled.");
  });

  test("12 is not supported by this server version", () => {
    expect(mapped(new MilvusError("unimplemented", "method ListNamespaces not implemented")).message).toBe(
      "The query is not supported by this server version. (Milvus: method ListNamespaces not implemented)",
    );
  });

  test("the receive cap is named in MiB", () => {
    expect(
      mapped(new MilvusError("receive-cap", "Received message larger than max (17825792 vs 16777216)")).message,
    ).toBe(
      "Milvus's answer to the query is larger than this connection's receive cap of 16 MiB: narrow the request. (Received message larger than max (17825792 vs 16777216))",
    );
  });

  test("a receive cap that is not whole MiB is named in KiB, or in bytes", () => {
    const cap = (receiveCapBytes: number) =>
      mapped(new MilvusError("receive-cap", "Received message larger than max"), {
        connection: { ...context().connection, receiveCapBytes },
      }).message;
    expect(cap(8 * 1024 * 1024 + 512 * 1024)).toContain("receive cap of 8704 KiB:");
    expect(cap(1_000_001)).toContain("receive cap of 1,000,001 bytes:");
  });

  test("101 is the not-loaded sentence of 5.3, with the load state when it is known", () => {
    const error = new MilvusError("status", "failed to query: collection not loaded[collection=1]", {
      status: { code: 101, errorCode: "UnexpectedError" },
    });
    expect(mapped(error, { collection: "unloaded_big", loadState: "NotLoad" }).message).toBe(
      "Collection unloaded_big is not loaded (state NotLoad). Query, get, count and search need a loaded collection, and loading uses query-node memory that every client of this cluster shares. An admin can load it from Operations; Studio never loads a collection on its own.",
    );
    expect(mapped(error, { collection: undefined }).message).toStartWith("The collection is not loaded. Query, get");
  });

  test("1100 is the input sentence, then the server's text with the filter's line and column", () => {
    const error = new MilvusError("status", "cannot parse expression: seq >>> 3: line 1:6 extraneous input '>'", {
      status: { code: 1100, errorCode: "IllegalArgument" },
    });
    expect(mapped(error).message).toBe(
      "Milvus refused the query's input: correct the request and run it again. (Milvus: cannot parse expression: seq >>> 3: line 1:6 extraneous input '>')",
    );
  });

  test("100, and code 0 with CollectionNotExists, say the collection does not exist in the database; 800 the database", () => {
    for (const status of [
      { code: 100, errorCode: "CollectionNotExists" },
      { code: 0, errorCode: "CollectionNotExists" },
    ]) {
      const error = new MilvusError("status", "can't find collection[database=default][collection=x]", { status });
      expect(mapped(error, { collection: "x" }).message).toBe(
        "Collection x does not exist in database default. (Milvus: can't find collection[database=default][collection=x])",
      );
    }
    const database = new MilvusError("status", "database not found[database=nope]", {
      status: { code: 800, errorCode: "UnexpectedError" },
    });
    expect(mapped(database, { database: "nope" }).message).toBe(
      "Database nope does not exist. (Milvus: database not found[database=nope])",
    );
  });

  test("2000, 2001 and 2099 never show the server's text, only a fragment of Studio's own (E20)", () => {
    const raw =
      "failed to search: worker(1) query failed: parser searchRequest failed:  => vector dimension mismatch, expected vector size(byte) 32, actual 16. at ../internal/core/src/query/Plan.cpp:183";
    const message = mapped(
      new MilvusError("status", raw, { status: { code: 2000, errorCode: "UnexpectedError" } }),
    ).message;
    expect(message).toBe(
      "Milvus rejected the request on the query node: the query vector's dimension does not match the field's.",
    );
    expect(message).not.toContain("Plan.cpp");
    const unknown = mapped(
      new MilvusError("status", 'knowhere config {"ef": 9} trace 0af7 at /src/x.cpp:1', {
        status: { code: 2099, errorCode: "UnexpectedError" },
      }),
    ).message;
    expect(unknown).toBe("Milvus rejected the request on the query node.");
    expect(
      mapped(
        new MilvusError("status", "unsupported data type VECTOR_BINARY for group by operator", {
          status: { code: 2001, errorCode: "UnexpectedError" },
        }),
      ).message,
    ).toBe("Milvus rejected the request on the query node: the group-by field's type cannot be grouped.");
  });

  test("any other status names its code and the server's text", () => {
    expect(
      mapped(
        new MilvusError("status", "metric type not found", { status: { code: 1200, errorCode: "UnexpectedError" } }),
      ).message,
    ).toBe("Milvus refused the query with code 1200 (UnexpectedError). (Milvus: metric type not found)");
  });

  test("an answer with no status, a closed client and anything unknown", () => {
    expect(mapped(new MilvusError("malformed", "Milvus answered Query with no status")).message).toBe(
      "Milvus's answer to the query carried no status, so Studio does not read it.",
    );
    expect(mapped(new MilvusError("closed", "The client is closed")).message).toBe(
      "This connection to Milvus is closed: connect again.",
    );
    expect(mapped(new MilvusError("unknown", "boom")).message).toBe("The query failed. (boom)");
    expect(mapped(new MilvusError("unavailable", "Received RST_STREAM")).message).toBe(
      "Milvus did not answer the query. (Received RST_STREAM)",
    );
  });

  test("a failure to connect names the endpoint and the TLS hint, plaintext or TLS, and under Bun the client certificate", () => {
    expect(mapped(new MilvusError("not-connected", "ECONNREFUSED")).message).toBe(
      "No Milvus answered a plaintext connection at milvus.test:19530. If this Milvus serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel. (ECONNREFUSED)",
    );
    const tls = { serverName: "milvus.test", clientCertificate: false };
    const bun = { ...context().connection, tls, runtimeReportsTlsCause: false };
    expect(mapped(new MilvusError("not-connected", "Failed to connect"), { connection: bun }).message).toStartWith(
      "No TLS connection to Milvus at milvus.test:19530 was established, and this runtime does not report why. No client certificate is configured:",
    );
    expect(
      mapped(new MilvusError("not-connected", "Failed to connect"), {
        connection: { ...bun, tls: { ...tls, clientCertificate: true } },
      }).message,
    ).toStartWith(
      "No TLS connection to Milvus at milvus.test:19530 was established, and this runtime does not report why: check the host, the port, the SSL mode, the client certificate and the tunnel.",
    );
    expect(
      mapped(new MilvusError("not-connected", "x"), { connection: { ...context().connection, tls } }).message,
    ).toStartWith("No Milvus answered a TLS connection at milvus.test:19530");
  });

  test("each TLS failure has its sentence, alert 45 among them (E6)", () => {
    const tlsContext = {
      connection: { ...context().connection, tls: { serverName: "10.0.0.5", clientCertificate: true } },
    };
    const sentence = (
      tlsFailure?:
        | "chain"
        | "name"
        | "not-tls"
        | "client-certificate-required"
        | "client-certificate-refused"
        | "client-certificate-expired",
    ) => mapped(new MilvusError("tls", "x", tlsFailure === undefined ? {} : { tlsFailure }), tlsContext).message;
    expect(sentence("chain")).toStartWith("The server's certificate is not signed by the CA under SSL / TLS");
    expect(sentence("name")).toStartWith("The certificate does not name 10.0.0.5");
    expect(sentence("not-tls")).toStartWith("This port did not answer TLS");
    expect(sentence("client-certificate-required")).toStartWith(
      "Milvus asked for a client certificate and did not accept",
    );
    expect(sentence("client-certificate-refused")).toStartWith("Milvus refused the client certificate under SSL / TLS");
    expect(sentence("client-certificate-expired")).toStartWith(
      "Milvus refused the client certificate under SSL / TLS because it has expired (client certificate expired)",
    );
    expect(sentence()).toStartWith("The TLS connection to Milvus failed.");
  });

  test("an IPv6 endpoint is bracketed, and a runtime text loses the address it names", () => {
    const v6 = { connection: { ...context().connection, host: "::1" } };
    expect(
      mapped(
        new MilvusError(
          "not-connected",
          "No connection established. Last error: connect ECONNREFUSED 127.0.0.1:41001 (x)",
        ),
        v6,
      ).message,
    ).toBe(
      "No Milvus answered a plaintext connection at [::1]:19530. If this Milvus serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel. (ECONNREFUSED)",
    );
    expect(
      mapped(new MilvusError("deadline-exceeded", "Deadline exceeded after 1s,remote_addr=127.0.0.1:41001")).message,
    ).toBe("The query reached its deadline of 30,000 ms. (Deadline exceeded after 1s)");
    expect(
      mapped(new MilvusError("not-connected", "Name resolution failed for target dns:unix:19530")).message,
    ).toEndWith("(Name resolution failed)");
  });
});

describe("toProviderError: Load and Release whose outcome is unknown (E7)", () => {
  const write = { operation: "Load of docs_int64", write: true };
  test.each([
    "connection-dropped",
    "ping-goaway",
    "unavailable",
    "transport",
    "deadline-exceeded",
    "cancelled",
    "unknown",
  ] as const)(
    "%s after the send says it may have been applied, and is never a connection or timeout error",
    (category) => {
      const error = mapped(new MilvusError(category, "x"), write);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toContain(
        "It may have been applied: read the collection's load state before you run it again.",
      );
    },
  );

  test("a call grpc-js never gave a transport, ended by a cancel or a timeout, is no unknown outcome", () => {
    const unsent = new MilvusUnsentStatus({
      code: 1,
      details: "Cancelled on client",
      message: "1 CANCELLED: Cancelled on client",
    });
    const cancel = new AbortController();
    cancel.abort();
    const timeout = new AbortController();
    timeout.abort(new DOMException("The operation timed out.", "TimeoutError"));
    for (const signal of [cancel.signal, timeout.signal]) {
      for (const error of [toMilvusError(unsent, signal), toMilvusError(signal.reason, signal)]) {
        const message = mapped(error, write).message;
        expect(message).not.toContain("may have been applied");
        expect(message).not.toContain("after it was sent");
      }
    }
  });

  test.each(["not-connected", "closed", "unauthenticated", "permission-denied", "status"] as const)(
    "%s says nothing was applied: no unknown-outcome sentence",
    (category) => {
      const error = new MilvusError(
        category,
        "x",
        category === "status" ? { status: { code: 65535, errorCode: "UnexpectedError" } } : {},
      );
      expect(mapped(error, write).message).not.toContain("may have been applied");
    },
  );
});

describe("toProviderError: an echoed credential is withheld in every place a server text reaches a sentence (E4, VF9, Review Focus 1)", () => {
  const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const echoes = [
    `token ${base64(`root:${TEST_PASSWORD}`)} rejected`,
    `user root:${TEST_PASSWORD} rejected`,
    `password ${TEST_PASSWORD} rejected`,
  ];

  test.each(echoes)("an echo %j in a status reason, a 16 and a 14 is withheld whole", (echo) => {
    const answers = [
      new MilvusError("status", echo, { status: { code: 1100, errorCode: "IllegalArgument" } }),
      new MilvusError("unauthenticated", echo, { grpcCode: 16 }),
      new MilvusError("unavailable", echo, { grpcCode: 14 }),
      new MilvusError("not-connected", echo, { grpcCode: 14 }),
    ];
    for (const answer of answers) {
      const message = mapped(answer).message;
      expect(message).toContain(WITHHELD);
      for (const form of FORMS) expect(message).not.toContain(form);
    }
  });

  test("a code 2000 reason that echoes the credential shows none of it", () => {
    const message = mapped(
      new MilvusError("status", `vector dimension mismatch ${base64(`root:${TEST_PASSWORD}`)}`, {
        status: { code: 2000, errorCode: "UnexpectedError" },
      }),
    ).message;
    for (const form of FORMS) expect(message).not.toContain(form);
  });
});

describe("toProviderError: what is not a MilvusError", () => {
  test("a configuration refusal with no provider is re-raised as Milvus's, message unchanged", () => {
    const error = toProviderError(new DatabaseConfigError("Invalid host"), context());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    // Widened to string, so the assertion compiles before the type-id is registered (part D).
    const provider: string | undefined = (error as DatabaseConfigError).provider;
    expect(provider).toBe("milvus");
    expect(error.message).toBe("Invalid host");
  });

  test("any other Error surfaces as itself, and a thrown non-Error becomes an Error saying so", () => {
    const own = new Error("a local refusal");
    expect(toProviderError(own, context())).toBe(own);
    expect(toProviderError(42, context()).message).toBe(
      "The Milvus provider received a thrown value that is not an Error: 42",
    );
  });
});

describe("unsupportedDataTypeError (E20)", () => {
  test("names the type and never guesses", () => {
    expect(unsupportedDataTypeError(27).message).toBe(
      "Milvus returned a field of unsupported type 27, which Studio does not read rather than guess.",
    );
  });
});
