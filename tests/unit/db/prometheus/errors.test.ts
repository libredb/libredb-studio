/**
 * Prometheus error mapping (#1085, section 5.5)
 *
 * Every category of the transport contract, and an engine errorType this build does not know, mapped to
 * the repository's error vocabulary. The transport errors are built directly here: the transport's own
 * tests pin how each category arises, and this file pins only what each one becomes.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { rejectRedirect } from "@/lib/db/http/endpoint";
import { type ErrorContext, toDatabaseError } from "@/lib/db/providers/timeseries/prometheus/errors";
import { authorizationFor, RESPONSE_BYTE_CAP } from "@/lib/db/providers/timeseries/prometheus/http-transport";
import {
  type PrometheusErrorDetail,
  PrometheusTransportError,
} from "@/lib/db/providers/timeseries/prometheus/transport";

const CONTEXT: ErrorContext = {
  provider: "prometheus",
  query: "rate(prometheus_http_requests_total[5m])",
  timeoutMs: 30_000,
  host: "prom.internal",
  port: 9090,
};

function transportFailure(
  category: string,
  message = `the ${category} sentence`,
  detail: PrometheusErrorDetail = {},
): PrometheusTransportError {
  return new PrometheusTransportError(category, message, detail);
}

type ErrorClass = new (...args: never[]) => Error;

describe("the class each category becomes (5.5)", () => {
  test.each<[string, string, ErrorClass]>([
    ["bad_data", "QueryError", QueryError],
    ["execution", "QueryError", QueryError],
    ["unmeasurable", "QueryError", QueryError],
    ["not_found", "QueryError", QueryError],
    ["not_acceptable", "QueryError", QueryError],
    ["timeout", "TimeoutError", TimeoutError],
    ["deadline", "TimeoutError", TimeoutError],
    ["canceled", "QueryCancelledError", QueryCancelledError],
    ["aborted", "QueryCancelledError", QueryCancelledError],
    ["unavailable", "ConnectionError", ConnectionError],
    ["internal", "ConnectionError", ConnectionError],
    ["network", "ConnectionError", ConnectionError],
    ["protocol", "ConnectionError", ConnectionError],
    ["unauthorized", "AuthenticationError", AuthenticationError],
    ["credential", "DatabaseConfigError", DatabaseConfigError],
  ])("%s becomes a %s, its message carried verbatim", (category, _name, errorClass) => {
    const original = transportFailure(category);

    const mapped = toDatabaseError(original, CONTEXT);

    expect(mapped).toBeInstanceOf(errorClass);
    expect(mapped.message).toBe(original.message);
    expect((mapped as DatabaseError).provider).toBe("prometheus");
  });
});

describe("what each class carries", () => {
  test("a QueryError carries the statement", () => {
    const mapped = toDatabaseError(transportFailure("bad_data"), CONTEXT) as QueryError;

    expect(mapped.query).toBe(CONTEXT.query);
  });

  test.each(["timeout", "deadline"])("a TimeoutError from %s carries the deadline and the statement", (category) => {
    const mapped = toDatabaseError(transportFailure(category), CONTEXT) as TimeoutError;

    expect(mapped.timeout).toBe(30_000);
    expect(mapped.query).toBe(CONTEXT.query);
  });

  test.each(["canceled", "aborted"])("a QueryCancelledError from %s carries the statement", (category) => {
    const mapped = toDatabaseError(transportFailure(category), CONTEXT) as QueryCancelledError;

    expect(mapped.query).toBe(CONTEXT.query);
  });

  test.each(["unavailable", "internal", "network", "protocol"])(
    "a ConnectionError from %s carries the host and the port",
    (category) => {
      const mapped = toDatabaseError(transportFailure(category), CONTEXT) as ConnectionError;

      expect(mapped.host).toBe("prom.internal");
      expect(mapped.port).toBe(9090);
    },
  );
});

describe("a refused credential (#1085 S3)", () => {
  test("is a DatabaseConfigError whose message is the transport's own, which never holds the value", () => {
    let refusal: unknown;
    try {
      authorizationFor({ user: "alice", password: "pw\nSECRET-VALUE" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PrometheusTransportError);

    const mapped = toDatabaseError(refusal, CONTEXT);

    expect(mapped).toBeInstanceOf(DatabaseConfigError);
    expect(mapped.message).toBe((refusal as PrometheusTransportError).message);
    // The control: the message names the field, so the absences below are of the value, not of a message.
    expect(mapped.message).toContain("password or token");
    expect(mapped.message).not.toContain("SECRET-VALUE");
    expect(mapped.message).not.toContain(Buffer.from("alice:pw\nSECRET-VALUE", "utf8").toString("base64"));
  });
});

describe("anything that is not a transport error", () => {
  test("a DatabaseError passes through as the same object", () => {
    const configError = new DatabaseConfigError("The host is not a hostname or an IP literal", "prometheus");
    const queryError = new QueryError("already mapped", "prometheus", "up");

    expect(toDatabaseError(configError, CONTEXT)).toBe(configError);
    expect(toDatabaseError(queryError, CONTEXT)).toBe(queryError);
  });

  test("the ConnectionError the shared redirect refusal throws passes through as the same object (#1085 S2)", () => {
    let caught: unknown;
    try {
      rejectRedirect(
        { status: 307, headers: new Headers({ location: "https://login.example.com/sso?token=abc" }) },
        "http://prom.internal:9090/api/v1/rules",
      );
    } catch (error) {
      caught = error;
    }
    // The control: the shared module named the status and the target origin, and neither the target's path
    // nor its query, so what passes through below is that refusal and not a message this file built.
    expect(caught).toBeInstanceOf(ConnectionError);
    const refusal = caught as ConnectionError;
    expect(refusal.message).toContain("HTTP 307");
    expect(refusal.message).toContain("https://login.example.com");
    expect(refusal.message).not.toContain("/sso");
    expect(refusal.message).not.toContain("token=abc");

    expect(toDatabaseError(refusal, CONTEXT)).toBe(refusal);
  });

  test("an Error the shared mapper recognises becomes its class", () => {
    const mapped = toDatabaseError(new Error("connect ECONNREFUSED 127.0.0.1:9090"), CONTEXT);

    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toContain("ECONNREFUSED");
  });

  test("an Error the shared mapper does not recognise stays a DatabaseError with its message and statement", () => {
    const mapped = toDatabaseError(new Error("something unexpected"), CONTEXT);

    expect(mapped.constructor).toBe(DatabaseError);
    expect(mapped.message).toBe("something unexpected");
    expect((mapped as DatabaseError).query).toBe(CONTEXT.query);
  });

  test("a thrown value that is not an Error becomes a DatabaseError holding its text", () => {
    const mapped = toDatabaseError("a thrown string", CONTEXT);

    expect(mapped.constructor).toBe(DatabaseError);
    expect(mapped.message).toBe("a thrown string");
    expect((mapped as DatabaseError).provider).toBe("prometheus");
  });
});

describe("the messages built here (#1085 S5 and #1085 S8)", () => {
  test("a TLS failure is named once by its Node error code, from the message request.ts sends", () => {
    const tls = transportFailure("tls", "The TLS connection failed (DEPTH_ZERO_SELF_SIGNED_CERT)", {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });

    const mapped = toDatabaseError(tls, CONTEXT);

    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "The TLS connection to the server failed (DEPTH_ZERO_SELF_SIGNED_CERT). The request was not retried over plain HTTP.",
    );
    expect(mapped.message.split("DEPTH_ZERO_SELF_SIGNED_CERT")).toHaveLength(2);
    expect((mapped as ConnectionError).host).toBe("prom.internal");
    expect((mapped as ConnectionError).port).toBe(9090);
  });

  test("a TLS failure whose message already names the code in another form still names it once", () => {
    const tls = transportFailure("tls", "DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate", {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });

    const mapped = toDatabaseError(tls, CONTEXT);

    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "The TLS connection to the server failed (DEPTH_ZERO_SELF_SIGNED_CERT). The request was not retried over plain HTTP.",
    );
  });

  test("a TLS failure with no code keeps the transport's message", () => {
    const mapped = toDatabaseError(transportFailure("tls", "the handshake was reset", {}), CONTEXT);

    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "The TLS connection to the server failed: the handshake was reset. The request was not retried over plain HTTP.",
    );
  });

  test("an answer past the byte cap names the cap and says how to ask for less", () => {
    const tooLarge = transportFailure("too_large", "past the cap", { limitBytes: RESPONSE_BYTE_CAP });

    const mapped = toDatabaseError(tooLarge, CONTEXT);

    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(
      `The server's answer passed the ${RESPONSE_BYTE_CAP.toLocaleString("en-US")}-byte response cap and was not ` +
        "read to the end. Ask for less: a narrower range, a larger step, or fewer series.",
    );
    expect((mapped as QueryError).query).toBe(CONTEXT.query);
  });

  test("an answer past a cap it was not told still says how to ask for less", () => {
    const mapped = toDatabaseError(transportFailure("too_large", "past the cap", {}), CONTEXT);

    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(
      "The server's answer passed the response cap and was not read to the end. Ask for less: a narrower range, " +
        "a larger step, or fewer series.",
    );
  });
});
