import { afterEach, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Readable, type Transform } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

// The test runner starts a process per file, keeping these built-in module mocks isolated.
const realDns = { ...(await import("node:dns")) };
const realHttp = { ...(await import("node:http")) };
const realHttps = { ...(await import("node:https")) };
const realZlib = { ...(await import("node:zlib")) };

type Reply = {
  body: Buffer;
  headers: IncomingMessage["headers"];
  statusCode?: number;
  /** The message hands over its body and never ends, as a connection still open mid-body. */
  open?: boolean;
};

let reply: Reply = { body: Buffer.from("ok"), headers: { "content-type": "text/plain" } };
const requests: Array<{ options: RequestOptions; body: unknown; client: ClientRequest; protocol: string }> = [];
const lookups: Array<{ hostname: string; all: unknown }> = [];
let lastIncoming: IncomingMessage | undefined;
/** Every decoder the transport built. */
const decoders: Transform[] = [];

function fakeRequest(protocol: string) {
  return (options: RequestOptions, onResponse: (incoming: IncomingMessage) => void): ClientRequest => {
    const client = Object.assign(new EventEmitter(), {
      destroyed: false,
      method: (options.method ?? "GET").toUpperCase(),
      end(body?: unknown) {
        requests.push({ options, body, client: client as ClientRequest, protocol });
        const incoming = (reply.open ? new Readable({ read() {} }) : Readable.from([reply.body])) as IncomingMessage;
        if (reply.open) incoming.push(reply.body);
        incoming.headers = reply.headers;
        incoming.statusCode = reply.statusCode ?? 200;
        incoming.statusMessage = "OK";
        lastIncoming = incoming;
        queueMicrotask(() => onResponse(incoming));
        return client;
      },
      destroy() {
        client.destroyed = true;
        return client;
      },
    });
    return client as ClientRequest;
  };
}

mock.module("node:dns", () => ({
  ...realDns,
  lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) {
    lookups.push({ hostname, all: options.all });
    if (hostname === "missing.example") callback(new Error("DNS failure"), []);
    else callback(null, [{ address: "8.8.8.8", family: 4 }]);
  },
}));
mock.module("node:http", () => ({ ...realHttp, request: fakeRequest("http:") }));
mock.module("node:https", () => ({ ...realHttps, request: fakeRequest("https:") }));
function built<T extends Transform>(decoder: T): T {
  decoders.push(decoder);
  return decoder;
}
mock.module("node:zlib", () => ({
  ...realZlib,
  createGunzip: () => built(realZlib.createGunzip()),
  createInflate: () => built(realZlib.createInflate()),
  createBrotliDecompress: () => built(realZlib.createBrotliDecompress()),
}));

const { httpTransportFetch, publicAddressLookup } = await import("@/lib/db/http/egress-policy");
const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];

afterEach(() => {
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
  requests.length = 0;
  lookups.length = 0;
  lastIncoming = undefined;
  decoders.length = 0;
  reply = { body: Buffer.from("ok"), headers: { "content-type": "text/plain" } };
});

test("returns DNS errors to the socket lookup callback", async () => {
  const error = await new Promise<Error | null>((resolve) => {
    publicAddressLookup("missing.example", { all: true }, (failure) => resolve(failure));
  });
  expect(error?.message).toBe("DNS failure");
});

test("validates every DNS answer before returning either lookup callback shape", async () => {
  const all = await new Promise<LookupAddress[]>((resolve, reject) => {
    publicAddressLookup("public.example", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else if (Array.isArray(addresses)) resolve(addresses);
      else reject(new Error("Expected all DNS answers"));
    });
  });
  const one = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    publicAddressLookup("public.example", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string" && family !== undefined) resolve({ address, family });
      else reject(new Error("Expected one DNS answer"));
    });
  });
  expect(all).toEqual([{ address: "8.8.8.8", family: 4 }]);
  expect(one).toEqual({ address: "8.8.8.8", family: 4 });
  expect(lookups).toEqual([
    { hostname: "public.example", all: true },
    { hostname: "public.example", all: true },
  ]);
});

test.each([
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
] as const)("decodes %s responses from the pinned request", async (encoding, compress) => {
  process.env[flag] = "true";
  reply = {
    body: compress(Buffer.from("decoded")),
    headers: { "content-encoding": encoding, "content-length": "100", "x-multiple": ["one", "two"] },
  };

  const response = await httpTransportFetch("https://8.8.8.8/query", { method: "POST", body: "query" });

  expect(await response.text()).toBe("decoded");
  expect(response.headers.get("x-multiple")).toBe("one, two");
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.has("content-length")).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0].protocol).toBe("https:");
  expect(requests[0].options.agent).toBe(false);
  expect(requests[0].options.lookup).toBe(publicAddressLookup);
  expect(requests[0].body).toBe("query");
});

test("preserves an empty response for HEAD", async () => {
  process.env[flag] = "true";
  const response = await httpTransportFetch("http://8.8.8.8/query", { method: "HEAD" });
  expect(response.body).toBeNull();
  expect(requests[0].protocol).toBe("http:");
});

/** Records every uncaught exception and unhandled rejection until stop(): a failure the caller never received. */
function recordUncaught() {
  const seen: unknown[] = [];
  const record = (error: unknown): void => {
    seen.push(error);
  };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  return {
    seen,
    stop() {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    },
  };
}

/** Lets every stream event already queued run, so a failure emitted after the answer resolved is seen. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test.each([
  [204, "GET", "gzip"],
  [205, "GET", "br"],
  [304, "GET", "deflate"],
  [200, "HEAD", "gzip"],
  [200, "head", "gzip"],
] as const)(
  "hands a %i answer to %s naming %s on without a body, and no stream fails after it",
  async (statusCode, method, encoding) => {
    process.env[flag] = "true";
    reply = {
      body: Buffer.alloc(0),
      headers: { "content-encoding": encoding, "content-length": "0", etag: '"v1"' },
      statusCode,
    };
    const uncaught = recordUncaught();
    try {
      const response = await httpTransportFetch("https://8.8.8.8/query", { method });
      await settle();

      expect(response.status).toBe(statusCode);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe('"v1"');
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
      expect(lastIncoming?.destroyed).toBe(true);
      expect(decoders).toEqual([]);
      expect(uncaught.seen).toEqual([]);
    } finally {
      uncaught.stop();
    }
  },
);

test.each([
  ["gzip", Buffer.from("not gzip at all"), "incorrect header check (Z_DATA_ERROR)"],
  ["gzip", Buffer.alloc(0), "unexpected end of file (Z_BUF_ERROR)"],
  ["deflate", Buffer.from("not deflate"), "incorrect header check (Z_DATA_ERROR)"],
  ["br", Buffer.from("not brotli"), "Decompression failed (ERR__ERROR_FORMAT_PADDING_2)"],
] as const)("fails the read of a %s body that does not decode with a named error", async (encoding, body, reason) => {
  process.env[flag] = "true";
  reply = { body, headers: { "content-encoding": encoding } };
  const uncaught = recordUncaught();
  try {
    const response = await httpTransportFetch("https://8.8.8.8/query");
    const failure = await response.text().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "AnswerDecodingError",
      message: `The server's ${encoding} answer could not be decoded: ${reason}`,
    });
    expect((failure as { code?: unknown }).code).toBeUndefined();
    expect((failure as Error).cause).toMatchObject({ code: reason.slice(reason.indexOf("(") + 1, -1) });
    await settle();
    expect(lastIncoming?.destroyed).toBe(true);
    expect(uncaught.seen).toEqual([]);
  } finally {
    uncaught.stop();
  }
});

test("fails the read with the connection's own error when it fails mid-body", async () => {
  process.env[flag] = "true";
  reply = {
    body: gzipSync(Buffer.from("partial")).subarray(0, 12),
    headers: { "content-encoding": "gzip" },
    open: true,
  };
  const response = await httpTransportFetch("https://8.8.8.8/query");
  const reading = response.text();
  const cut = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  // Node's own client listens on a real message too, so a failure nobody forwards leaves the read waiting.
  lastIncoming?.on("error", () => {});
  lastIncoming?.destroy(cut);
  await expect(Promise.race([reading, settle().then(() => "still waiting")])).rejects.toBe(cut);
});

test("closes the connection when the reader cancels a decoded body", async () => {
  process.env[flag] = "true";
  reply = {
    body: gzipSync(Buffer.from("partial")).subarray(0, 12),
    headers: { "content-encoding": "gzip" },
    open: true,
  };
  const response = await httpTransportFetch("https://8.8.8.8/query");
  await response.body?.cancel();
  await settle();
  expect(lastIncoming?.destroyed).toBe(true);
  expect(decoders).toHaveLength(1);
  expect(decoders[0].destroyed).toBe(true);
});

test("passes headers and an abort signal to the socket and returns a non-200 status", async () => {
  process.env[flag] = "true";
  reply = { body: Buffer.from("unavailable"), headers: { "retry-after": "5" }, statusCode: 503 };
  const controller = new AbortController();
  const response = await httpTransportFetch("http://8.8.8.8/query", {
    headers: { authorization: "Basic test" },
    signal: controller.signal,
  });
  expect(requests[0].options.headers).toEqual({ authorization: "Basic test" });
  expect(requests[0].options.signal).toBe(controller.signal);
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("5");
  expect(await response.text()).toBe("unavailable");
});

test("destroys the incoming stream when its headers are invalid", async () => {
  process.env[flag] = "true";
  reply.headers = { "x-invalid": "line one\nline two" };
  await expect(httpTransportFetch("http://8.8.8.8/query")).rejects.toThrow();
  expect(lastIncoming?.destroyed).toBe(true);
});

test("rejects a non-string request body before sending it", async () => {
  process.env[flag] = "true";
  await expect(httpTransportFetch("http://8.8.8.8/query", { body: new Blob(["binary"]) })).rejects.toThrow(
    "HTTP database request body must be a string",
  );
  expect(requests).toHaveLength(0);
});
