import { afterEach, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

// The test runner starts a process per file, keeping these built-in module mocks isolated.
const realDns = { ...(await import("node:dns")) };
const realHttp = { ...(await import("node:http")) };
const realHttps = { ...(await import("node:https")) };

type Reply = {
  body: Buffer;
  headers: IncomingMessage["headers"];
  statusCode?: number;
};

let reply: Reply = { body: Buffer.from("ok"), headers: { "content-type": "text/plain" } };
const requests: Array<{ options: RequestOptions; body: unknown; client: ClientRequest; protocol: string }> = [];
const lookups: Array<{ hostname: string; all: unknown }> = [];
let lastIncoming: IncomingMessage | undefined;

function fakeRequest(protocol: string) {
  return (options: RequestOptions, onResponse: (incoming: IncomingMessage) => void): ClientRequest => {
    const client = Object.assign(new EventEmitter(), {
      destroyed: false,
      end(body?: unknown) {
        requests.push({ options, body, client: client as ClientRequest, protocol });
        const incoming = Readable.from([reply.body]) as IncomingMessage;
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

const { httpTransportFetch, publicAddressLookup } = await import("@/lib/db/http/egress-policy");
const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];

afterEach(() => {
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
  requests.length = 0;
  lookups.length = 0;
  lastIncoming = undefined;
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
