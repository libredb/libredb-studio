/**
 * The Milvus error table (vector-family spec 5.10, E6, E7, E13, E14, E20). This file pins the adapter's half: how a
 * grpc-js status, a runtime error, the call's own abort and a common.Status are classified. Texts are the ones the
 * research measured (R09 section 8, R41, R42 M12), so a classification that drifts from what the server and the
 * runtimes say fails here; the captured answers are classified again in milvus-fixtures.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { MilvusError, type WireStatus } from "@/lib/db/providers/vector/milvus/client";
import {
  isReceiveCapError,
  MilvusUnsentStatus,
  statusFailure,
  toMilvusError,
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
