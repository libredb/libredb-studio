/**
 * TransportError.truncated, set by state (InfluxDB SPEC 3.3 and E11, R3 and R20).
 *
 * A raw TCP listener writes the status line and headers itself, then cuts the socket with a FIN (`socket.destroy()`) or
 * an RST (`socket.resetAndDestroy()`), at zero body bytes, mid-chunk and at a chunk boundary: every cut is kind
 * "network" with `truncated: true`, never an answer, because a cut body never emits `end` on either runtime
 * (02-design/evidence-SR3/07-node-truncation.txt). The other failures keep their kinds with `truncated: false`, the ones
 * raised after the response callback ran among them: a deadline, a cancel, the byte cap, a redirect and an encoding.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { ConnectionError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeRequest, TransportError } from "@/lib/db/http/node-transport";

const TRUNCATED = "The server ended the response before it was complete";
const MIB = 1024 * 1024;
const CHUNKED = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
const ONE_LINE_CHUNK = '8\r\n{"a":1}\n\r\n';

/** Writes `text`, then after the client has read it, cuts the socket. */
function cutAfter(text: string, cut: "fin" | "rst"): (socket: Socket) => void {
  return (socket) => {
    socket.write(text, () => setTimeout(() => (cut === "fin" ? socket.destroy() : socket.resetAndDestroy()), 30));
  };
}

/** What the listener does with each request, by its path. */
const BEHAVIOURS: readonly (readonly [string, (socket: Socket) => void])[] = [
  ["/fin-zero", cutAfter(CHUNKED, "fin")],
  ["/rst-zero", cutAfter(CHUNKED, "rst")],
  ["/fin-mid", cutAfter(`${CHUNKED}40\r\n0123456789`, "fin")],
  ["/rst-mid", cutAfter(`${CHUNKED}40\r\n0123456789`, "rst")],
  ["/fin-line", cutAfter(CHUNKED + ONE_LINE_CHUNK, "fin")],
  ["/rst-line", cutAfter(CHUNKED + ONE_LINE_CHUNK, "rst")],
  ["/complete-empty", (socket) => socket.write(`${CHUNKED}0\r\n\r\n`)],
  ["/complete-line", (socket) => socket.write(`${CHUNKED + ONE_LINE_CHUNK}0\r\n\r\n`)],
  ["/hold", (socket) => socket.write(CHUNKED)],
  ["/big", (socket) => socket.write(`${CHUNKED}40\r\n${"x".repeat(64)}\r\n`)],
  [
    "/redirect",
    (socket) =>
      socket.write("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\n\r\n"),
  ],
  [
    "/gzip",
    (socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n"),
  ],
];

let server: Server;
let port = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const path = head.split(" ")[1];
      // Chosen by comparing the request's path with each known one, never by looking a name up.
      const behaviour = BEHAVIOURS.find(([known]) => known === path);
      if (behaviour === undefined) throw new Error(`The test server has no behaviour for ${path}`);
      behaviour[1](socket);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(path: string, extra: Partial<NodeRequest> = {}, at = port) {
  const origin = httpOrigin("http", "127.0.0.1", at);
  const transport = createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} });
  return transport
    .request({
      method: "GET",
      url: endpointUrl(origin, path),
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: MIB,
      ...extra,
    })
    .finally(() => transport.close());
}

async function failure(run: () => Promise<unknown>): Promise<TransportError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TransportError);
    return error as TransportError;
  }
  throw new Error("expected the request to fail");
}

const summary = (error: TransportError) => ({ kind: error.kind, truncated: error.truncated, message: error.message });

describe("a body cut before its terminating chunk", () => {
  test.each([
    ["a FIN at zero body bytes", "/fin-zero"],
    ["an RST at zero body bytes", "/rst-zero"],
    ["a FIN mid-chunk", "/fin-mid"],
    ["an RST mid-chunk", "/rst-mid"],
    ["a FIN at a chunk boundary", "/fin-line"],
    ["an RST at a chunk boundary", "/rst-line"],
  ])("%s is kind network with truncated true, never an answer", async (_label, path) => {
    const error = await failure(() => send(path));
    expect(summary(error)).toEqual({ kind: "network", truncated: true, message: TRUNCATED });
    expect(error).toBeInstanceOf(ConnectionError);
  });
});

describe("answers and failures that are not a truncation", () => {
  test("a complete zero-length chunked body is a normal answer", async () => {
    const answer = await send("/complete-empty");
    expect(answer).toEqual({ status: 200, contentType: "application/json", retryAfter: null, text: "" });
  });

  test("a complete one-line chunked body is a normal answer", async () => {
    expect((await send("/complete-line")).text).toBe('{"a":1}\n');
  });

  test("a refused connection is network with truncated false", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const unused = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = await failure(() => send("/x", {}, unused));
    expect(summary(error)).toEqual({
      kind: "network",
      truncated: false,
      message: "The request failed before a complete response arrived (ECONNREFUSED)",
    });
  });

  test("a deadline after the headers stays timeout with truncated false", async () => {
    const error = await failure(() => send("/hold", { signal: AbortSignal.timeout(200) }));
    expect(summary(error)).toEqual({
      kind: "timeout",
      truncated: false,
      message: "The request did not finish within its time limit",
    });
  });

  test("a cancel after the headers stays aborted with truncated false", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const error = await failure(() => send("/hold", { signal: controller.signal }));
    expect(summary(error)).toEqual({ kind: "aborted", truncated: false, message: "The request was cancelled" });
  });

  test("the byte cap after the headers stays too-large with truncated false", async () => {
    const error = await failure(() => send("/big", { maxResponseBytes: 10 }));
    expect(summary(error)).toEqual({
      kind: "too-large",
      truncated: false,
      message: "The response exceeded the 10-byte limit for one response, so it was not read to the end",
    });
  });

  test("a redirect, refused in the response callback, stays redirect with truncated false", async () => {
    const error = await failure(() => send("/redirect"));
    expect(error.kind).toBe("redirect");
    expect(error.truncated).toBe(false);
  });

  test("an unsupported content-encoding, refused in the response callback, stays encoding with truncated false", async () => {
    const error = await failure(() => send("/gzip"));
    expect(error.kind).toBe("encoding");
    expect(error.truncated).toBe(false);
  });
});

describe("the constructor", () => {
  test("a two-argument call gets truncated false", () => {
    expect(new TransportError("tls", "x").truncated).toBe(false);
    expect(new TransportError("network", "x", {}).truncated).toBe(false);
  });

  test("the options argument sets it", () => {
    const error = new TransportError("network", "x", { truncated: true });
    expect({ kind: error.kind, truncated: error.truncated, name: error.name }).toEqual({
      kind: "network",
      truncated: true,
      name: "TransportError",
    });
  });
});

describe("the redirect detail", () => {
  test("a TransportError built with two or three arguments carries no redirect detail", () => {
    expect(new TransportError("redirect", "x").redirect).toBeUndefined();
    expect(new TransportError("redirect", "x", { truncated: false }).redirect).toBeUndefined();
  });

  test("the options argument sets it", () => {
    const redirect = {
      status: 301,
      headers: [["x-amz-bucket-region", "eu-west-1"] as const],
      headersTruncated: false,
    };
    const error = new TransportError("redirect", "x", { redirect });
    expect({ kind: error.kind, truncated: error.truncated, redirect: error.redirect }).toEqual({
      kind: "redirect",
      truncated: false,
      redirect: { status: 301, headers: [["x-amz-bucket-region", "eu-west-1"]], headersTruncated: false },
    });
  });

  test("a 3xx refused on the text path carries no redirect detail", async () => {
    const error = await failure(() => send("/redirect"));
    expect(error.kind).toBe("redirect");
    expect(error.redirect).toBeUndefined();
  });
});
