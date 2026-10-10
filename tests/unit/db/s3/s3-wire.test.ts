/**
 * The socket-free S3 transports of tests/helpers/s3-wire.ts: the recorded transport the
 * replay runs the provider over, the scripted transport of the unit tests, and the harness's signer wrapper.
 *
 * The recorded transport calls the signer exactly where the byte transport does, once per request at send time, and
 * compares what was signed and sent with the recording before it answers; a mismatch fails by name, and nothing is
 * served for a request that differs. No case opens a socket: a spy on node:net counts connects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { httpOrigin } from "@/lib/db/http/endpoint";
import type { NodeByteTransportOptions, RequestSigner, SigningInput } from "@/lib/db/http/node-transport";
import {
  amzDate,
  parseAuthorization,
  recordedBody,
  recordedS3Transport,
  recordingSigner,
  type S3Capture,
  type S3Exchange,
  type S3RecordedAnswer,
  scriptedS3Transport,
} from "../../../helpers/s3-wire";

let sockets = 0;
const originalConnect = net.Socket.prototype.connect;
beforeAll(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    sockets++;
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
  expect(sockets).toBe(0);
});

const DATE = "20261009T141900Z";
const PAYLOAD = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A signer that signs host, range when sent, and its own two x-amz headers, the shape s3Signer returns. */
function fakeSigner(calls: SigningInput[], extra: Readonly<Record<string, string>> = {}): RequestSigner {
  return {
    headerNames: ["authorization", "x-amz-date", "x-amz-content-sha256", ...Object.keys(extra)],
    sign(input) {
      calls.push(input);
      const signed = ["host", ...("range" in input.headers ? ["range"] : []), "x-amz-content-sha256", "x-amz-date"];
      return {
        "x-amz-date": DATE,
        "x-amz-content-sha256": PAYLOAD,
        ...extra,
        authorization: `AWS4-HMAC-SHA256 Credential=libredb/20261009/us-east-1/s3/aws4_request, SignedHeaders=${signed.join(";")}, Signature=00`,
      };
    },
  };
}

function options(signer?: RequestSigner): NodeByteTransportOptions {
  return {
    origin: httpOrigin("http", "127.0.0.1", 9010),
    tls: null,
    maxSockets: 1,
    headers: {},
    requestHeaderNames: ["range"],
    responseHeaders: { names: ["etag", "date"], prefixes: ["x-amz-meta-"] },
    ...(signer === undefined ? {} : { signer }),
  };
}

const OK: S3RecordedAnswer = {
  status: 200,
  headers: [["date", "Fri, 09 Oct 2026 14:19:00 GMT"]],
  headersTruncated: false,
  contentType: "application/xml",
  contentEncoding: null,
  retryAfter: null,
  truncated: false,
  body: { text: "<ListAllMyBucketsResult/>" },
};

function exchange(path: string, extra: Partial<S3Exchange["request"]> = {}, answer: S3RecordedAnswer = OK): S3Exchange {
  const signed = [
    "host",
    ...(extra.headers?.range === undefined ? [] : ["range"]),
    "x-amz-content-sha256",
    "x-amz-date",
  ];
  return {
    step: "list",
    request: {
      method: "GET",
      path,
      query: "",
      headers: { host: "127.0.0.1:9010", "x-amz-date": DATE, "x-amz-content-sha256": PAYLOAD, ...extra.headers },
      authorization: {
        scheme: "AWS4-HMAC-SHA256",
        credential: "libredb/20261009/us-east-1/s3/aws4_request",
        signedHeaders: signed,
      },
      ...(extra.method === undefined ? {} : { method: extra.method }),
      ...(extra.query === undefined ? {} : { query: extra.query }),
    },
    answer,
  };
}

function capture(exchanges: S3Exchange[], clockOffsetMs = 0): S3Capture {
  return {
    file: "silo-2026-10-09-x/case.json",
    scenario: "case",
    target: "silo",
    clockOffsetMs,
    exchanges,
    result: null,
  };
}

const signal = new AbortController().signal;

describe("recordedS3Transport", () => {
  test("answers each request with the next exchange, calling the signer once per request with what is sent", async () => {
    const calls: SigningInput[] = [];
    const recorded = recordedS3Transport(capture([exchange("/"), exchange("/studio-demo", { query: "list-type=2" })]));
    const transport = recorded.createTransport(options(fakeSigner(calls)));
    const first = await transport.request({
      method: "GET",
      target: { path: "/", query: "" },
      signal,
      maxResponseBytes: 1024,
    });
    const second = await transport.request({
      method: "GET",
      target: { path: "/studio-demo", query: "list-type=2" },
      signal,
      maxResponseBytes: 1024,
    });
    expect(first.status).toBe(200);
    expect(second.bytes.toString("utf8")).toBe("<ListAllMyBucketsResult/>");
    expect(calls.map((input) => [input.method, input.host, input.path, input.query])).toEqual([
      ["GET", "127.0.0.1:9010", "/", ""],
      ["GET", "127.0.0.1:9010", "/studio-demo", "list-type=2"],
    ]);
    expect(recorded.sent.map((request) => request.path)).toEqual(["/", "/studio-demo"]);
    recorded.assertConsumed();
  });

  test("fails by name on a method, path or query that differs from the recording", async () => {
    for (const [request, needle] of [
      [{ method: "HEAD" as const, target: { path: "/", query: "" } }, "method"],
      [{ method: "GET" as const, target: { path: "/other", query: "" } }, "path"],
      [{ method: "GET" as const, target: { path: "/", query: "x=1" } }, "query"],
    ] as const) {
      const recorded = recordedS3Transport(capture([exchange("/")]));
      const transport = recorded.createTransport(options(fakeSigner([])));
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, so a failure names which field differed.
      await expect(transport.request({ ...request, signal, maxResponseBytes: 1024 })).rejects.toThrow(
        `case step list (exchange 1): ${needle} sent`,
      );
    }
  });

  test("a request whose range differs from the recording fails by name before any byte is served", async () => {
    const recorded = recordedS3Transport(
      capture([exchange("/studio-demo/data/one-mib.bin", { headers: { range: "bytes=0-4095" } })]),
    );
    const transport = recorded.createTransport(options(fakeSigner([])));
    await expect(
      transport.request({
        method: "GET",
        target: { path: "/studio-demo/data/one-mib.bin", query: "" },
        headers: { range: "bytes=-8" },
        signal,
        maxResponseBytes: 8192,
      }),
    ).rejects.toThrow('header range sent "bytes=-8", recorded "bytes=0-4095"');
  });

  test("fails by name when the SignedHeaders list or a signed value differs", async () => {
    const changedHost = recordedS3Transport(
      capture([
        {
          ...exchange("/"),
          request: { ...exchange("/").request, headers: { ...exchange("/").request.headers, host: "127.0.0.1:9020" } },
        },
      ]),
    );
    await expect(
      changedHost
        .createTransport(options(fakeSigner([])))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("header host sent");
    const changedHash = recordedS3Transport(
      capture([
        {
          ...exchange("/"),
          request: {
            ...exchange("/").request,
            headers: { ...exchange("/").request.headers, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
          },
        },
      ]),
    );
    await expect(
      changedHash
        .createTransport(options(fakeSigner([])))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("header x-amz-content-sha256 sent");
    const base = exchange("/");
    const fewer = recordedS3Transport(
      capture([
        {
          ...base,
          request: { ...base.request, authorization: { ...base.request.authorization!, signedHeaders: ["host"] } },
        },
      ]),
    );
    await expect(
      fewer
        .createTransport(options(fakeSigner([])))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("signedHeaders sent");
  });

  test("an x-amz header that is sent unsigned fails, and a signed request without x-amz-content-sha256 fails", async () => {
    const base = exchange("/");
    const withMeta = recordedS3Transport(
      capture([
        {
          ...base,
          request: { ...base.request, headers: { ...base.request.headers, "x-amz-checksum-mode": "ENABLED" } },
        },
      ]),
    );
    await expect(
      withMeta
        .createTransport(options(fakeSigner([], { "x-amz-checksum-mode": "ENABLED" })))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("x-amz-checksum-mode is sent but not signed");
    const noHash: RequestSigner = {
      headerNames: ["authorization", "x-amz-date"],
      sign: () => ({
        "x-amz-date": DATE,
        authorization:
          "AWS4-HMAC-SHA256 Credential=libredb/20261009/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=00",
      }),
    };
    const recorded = recordedS3Transport(
      capture([
        {
          ...base,
          request: {
            ...base.request,
            headers: { host: "127.0.0.1:9010", "x-amz-date": DATE },
            authorization: { ...base.request.authorization!, signedHeaders: ["host", "x-amz-date"] },
          },
        },
      ]),
    );
    await expect(
      recorded
        .createTransport(options(noHash))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("a signed request carries no x-amz-content-sha256");
  });

  test("assertConsumed fails on a recorded exchange the provider never asked for", () => {
    const recorded = recordedS3Transport(capture([exchange("/")]));
    expect(() => recorded.assertConsumed()).toThrow("case: 1 recorded exchange(s) were not sent, the first GET /");
  });

  test("an unsigned recording refuses a signed request, and a request past the recording fails", async () => {
    const base = exchange("/");
    const unsigned = recordedS3Transport(
      capture([{ ...base, request: { ...base.request, headers: { host: "127.0.0.1:9010" }, authorization: null } }]),
    );
    await expect(
      unsigned
        .createTransport(options(fakeSigner([])))
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("authorization sent");
    const empty = recordedS3Transport(capture([]));
    await expect(
      empty
        .createTransport(options())
        .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("case: request 1 has no recorded exchange: GET /");
  });

  test("the replay clock reads the recorded x-amz-date on a signed exchange and the recorded date plus the offset on an unsigned one", async () => {
    const signedOne = exchange("/");
    const unsignedTwo: S3Exchange = {
      ...signedOne,
      request: { ...signedOne.request, headers: { host: "127.0.0.1:9010" }, authorization: null },
    };
    const unsignedNoDate: S3Exchange = { ...unsignedTwo, answer: { ...OK, headers: [] } };
    const recorded = recordedS3Transport(capture([signedOne, unsignedTwo, unsignedNoDate], 1_200_000));
    expect(recorded.clock().toISOString()).toBe("2026-10-09T14:19:00.000Z");
    const transport = recorded.createTransport(options());
    const unsignedCapture = recordedS3Transport(capture([unsignedTwo, unsignedNoDate], 1_200_000));
    const unsignedTransport = unsignedCapture.createTransport(options());
    await unsignedTransport.request({
      method: "GET",
      target: { path: "/", query: "" },
      signal,
      maxResponseBytes: 1024,
    });
    expect(unsignedCapture.clock().toISOString()).toBe("2026-10-09T14:39:00.000Z");
    await unsignedTransport.request({
      method: "GET",
      target: { path: "/", query: "" },
      signal,
      maxResponseBytes: 1024,
    });
    expect(unsignedCapture.clock().toISOString()).toBe("2026-10-09T14:39:00.000Z");
    expect(transport).toBeDefined();
    expect(amzDate("20261009T141900Z").toISOString()).toBe("2026-10-09T14:19:00.000Z");
  });
});

describe("recordingSigner, the body forms and the authorization reader", () => {
  test("recordingSigner hands each input and the returned headers to its sink and returns them unchanged", () => {
    const calls: SigningInput[] = [];
    const inner = fakeSigner(calls);
    const seen: [SigningInput, Readonly<Record<string, string>>][] = [];
    const wrapped = recordingSigner(inner, (input, headers) => void seen.push([input, headers]));
    const input: SigningInput = {
      method: "GET",
      host: "127.0.0.1:9010",
      path: "/",
      query: "",
      headers: { host: "127.0.0.1:9010" },
    };
    const headers = wrapped.sign(input);
    expect(wrapped.headerNames).toEqual(inner.headerNames);
    expect(seen).toEqual([[input, headers]]);
    expect(headers["x-amz-date"]).toBe(DATE);
  });

  test("a body is text when it is valid UTF-8, base64 otherwise, and empty when it has no byte", () => {
    expect(recordedBody(new TextEncoder().encode("<a/>"))).toEqual({ text: "<a/>" });
    expect(recordedBody(new Uint8Array([0xff, 0x00]))).toEqual({ base64: "/wA=" });
    expect(recordedBody(new Uint8Array())).toEqual({ empty: true });
  });

  test("parseAuthorization keeps the scheme, the credential scope and the SignedHeaders, never the signature", () => {
    const parsed = parseAuthorization(
      "AWS4-HMAC-SHA256 Credential=AK/20261009/garage/s3/aws4_request, SignedHeaders=host;range;x-amz-date, Signature=abc",
    );
    expect(parsed).toEqual({
      scheme: "AWS4-HMAC-SHA256",
      credential: "AK/20261009/garage/s3/aws4_request",
      signedHeaders: ["host", "range", "x-amz-date"],
    });
    expect(JSON.stringify(parsed)).not.toContain("abc");
    expect(() => parseAuthorization("Basic eA==")).toThrow("not a SigV4 authorization");
  });
});

describe("scriptedS3Transport", () => {
  const step = (answer: S3RecordedAnswer | Error, expectRequest?: { path?: string }) =>
    ({
      answer,
      synthetic: true,
      source: "Garage, measured live",
      ...(expectRequest === undefined ? {} : { expect: expectRequest }),
    }) as const;

  test("answers scripted steps in order and rejects with a scripted error", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const scripted = scriptedS3Transport([step(OK, { path: "/" }), step(reset)]);
    const transport = scripted.createTransport(options());
    expect(
      (await transport.request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1024 }))
        .status,
    ).toBe(200);
    await expect(
      transport.request({ method: "GET", target: { path: "/b", query: "" }, signal, maxResponseBytes: 1024 }),
    ).rejects.toThrow("socket hang up");
    scripted.assertConsumed();
  });

  test("fails by name on a request the script does not expect, and refuses a step not marked synthetic", async () => {
    const scripted = scriptedS3Transport([step(OK, { path: "/expected" })]);
    await expect(
      scripted
        .createTransport(options())
        .request({ method: "GET", target: { path: "/other", query: "" }, signal, maxResponseBytes: 1 }),
    ).rejects.toThrow("path sent");
    expect(() => scriptedS3Transport([{ answer: OK, synthetic: false as unknown as true, source: "x" }])).toThrow(
      "a scripted step must be marked synthetic",
    );
  });
});

describe("the byte transport's own checks, replayed with no socket", () => {
  const scriptedOk = () =>
    scriptedS3Transport([
      { answer: OK, synthetic: true, source: "the ListAllMyBucketsResult shape of the S3 API reference" },
    ]);

  test("both factories run the byte transport's build checks, so a link-local origin is refused where the byte transport refuses it", () => {
    const linkLocal = { ...options(fakeSigner([])), origin: httpOrigin("http", "169.254.169.254", 80) };
    for (const wire of [recordedS3Transport(capture([exchange("/")])), scriptedOk()])
      expect(() => wire.createTransport(linkLocal)).toThrow("this connection never reaches a link-local address");
  });

  test("both transports refuse a query that is not name=value pairs before the signer is called, as the byte transport does", async () => {
    for (const wire of [
      recordedS3Transport(capture([exchange("/studio-demo", { query: "versions" })])),
      scriptedOk(),
    ]) {
      const calls: SigningInput[] = [];
      // oxlint-disable-next-line no-await-in-loop -- one transport at a time, so a failure names which one.
      await expect(
        wire
          .createTransport(options(fakeSigner(calls)))
          .request({ method: "GET", target: { path: "/studio-demo", query: "versions" }, signal, maxResponseBytes: 1 }),
      ).rejects.toThrow(
        "Invalid request query: expected name=value pairs of unreserved characters and upper-case percent escapes, joined by &",
      );
      expect(calls).toEqual([]);
      expect(wire.sent).toEqual([]);
    }
  });

  test("both transports refuse a signed value past 1024 bytes or outside visible ASCII, naming the header and never the value", async () => {
    for (const value of ["t".repeat(1025), "line\nbreak"]) {
      const signer = fakeSigner([], { "x-amz-security-token": value });
      for (const wire of [recordedS3Transport(capture([exchange("/")])), scriptedOk()]) {
        const failure = wire
          .createTransport(options(signer))
          .request({ method: "GET", target: { path: "/", query: "" }, signal, maxResponseBytes: 1 });
        // oxlint-disable-next-line no-await-in-loop -- one case at a time, so a failure names its value and transport.
        await expect(failure).rejects.toThrow(
          "Invalid signature headers: the value of x-amz-security-token must be visible ASCII or space, at most 1024 bytes",
        );
        // oxlint-disable-next-line no-await-in-loop -- the same rejection, read twice in turn.
        await expect(failure).rejects.not.toThrow(value);
      }
    }
  });
});
