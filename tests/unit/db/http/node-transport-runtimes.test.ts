/**
 * The transport's proxy, redirect, cap, encoding, truncation, Retry-After, TLS, tunnel, pooling and guard checks on the
 * runtimes production runs (vector-family spec 3.7 and 8.2): in a Bun child and in one Node child per binary that
 * NODE_TRANSPORT_NODES lists, split on the path delimiter, or else in the `node` on PATH, so CI's Node 24 runs them and
 * NODE_TRANSPORT_NODES=$HOME/.nvm/versions/node/v24.14.0/bin/node:$HOME/.nvm/versions/node/v26.7.0/bin/node runs both
 * Node lines in one pass. Each child must report the version its binary prints, so a listed Node never passes as another.
 *
 * Both children run one bundle that Bun.build({ target: "node" }) makes of node-transport.ts and endpoint.ts around the
 * text of `runCases`, as tests/unit/db/etcd/tls-handshake.test.ts runs its adapter, against listeners this file starts.
 * Each child starts with HTTP_PROXY, HTTPS_PROXY, their lower-case forms, ALL_PROXY and NODE_USE_ENV_PROXY=1 naming a
 * counting listener, because Node reads NODE_USE_ENV_PROXY only when it starts. After its cases each child sends one
 * control request through the global agent: the counting listener must see exactly that one, which proves the
 * variables were live, and the spy on the global agents must count exactly that one, which proves the spy watches.
 *
 * The byte transport's cases run after that control request (runByteCases). Each child starts from an unbundled
 * entry.mjs that answers the name metadata.test with 169.254.169.254 before the bundle loads, so the byte transport's
 * refusal of a link-local DNS answer, with DB_HTTP_BLOCK_PRIVATE_HOSTS off, is proven on every runtime listed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import type * as https from "node:https";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import type { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import type { createNodeTransport, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import {
  closeAll,
  countingListener,
  gzipOfZeros,
  httpListener,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  silentListener,
  streamingAnswer,
} from "../../../helpers/node-transport-fixtures";

interface Deps {
  readonly createNodeTransport: typeof createNodeTransport;
  readonly nodeTlsMaterial: typeof nodeTlsMaterial;
  readonly endpointUrl: typeof endpointUrl;
  readonly httpOrigin: typeof httpOrigin;
  readonly http: typeof http;
  readonly https: typeof https;
}

type PortName =
  | "plain"
  | "slow"
  | "secure"
  | "second"
  | "farName"
  | "farAddress"
  | "redirecting"
  | "big"
  | "bomb"
  | "holding"
  | "retry"
  | "guarded"
  | "silent"
  | "cut"
  | "corrupt";

interface Plan {
  readonly ports: Readonly<Record<PortName, number>>;
  readonly ca: string;
  readonly rogueCa: string;
  readonly secondCa: string;
  /** The raw listener the byte cases talk to. */
  readonly bytePort: number;
}

interface Outcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly retryAfter?: string | null;
  readonly text?: string;
  readonly errorName?: string;
  readonly kind?: string;
  readonly truncated?: boolean;
  readonly message?: string;
}

/** What one byte case came to: an answer's status, length, digest and flags, or a failure's name, kind and detail. */
interface ByteOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly length?: number;
  readonly digest?: number;
  readonly truncated?: boolean;
  readonly contentEncoding?: string | null;
  readonly errorName?: string;
  readonly kind?: string;
  readonly message?: string;
  readonly redirect?: unknown;
}

interface ByteDeps {
  readonly createNodeByteTransport: typeof import("@/lib/db/http/node-transport").createNodeByteTransport;
  readonly httpOrigin: typeof httpOrigin;
  readonly http: typeof http;
  readonly https: typeof https;
}

interface Report {
  readonly runtime: string;
  readonly outcomes: Record<string, Outcome>;
  readonly globalAgentCalls: { readonly duringCases: number; readonly withControl: number };
}

/** The byte transport's cases, run after the control request by runByteCases, merged into the child's report line. */
interface ByteReport {
  readonly byteOutcomes: Record<string, ByteOutcome>;
  readonly byteGlobalAgentCalls: number;
}

/** A child's report read with its byte fields: the parse line types it as a Report, and the child wrote both. */
function byteReport(run: ChildRun | undefined): (Report & ByteReport) | undefined {
  return run?.report as (Report & ByteReport) | undefined;
}

/**
 * Runs every case in turn and reports what each came to. SELF-CONTAINED ON PURPOSE: each child runs this function's own
 * text (`runCases.toString()`), so it names nothing but its parameters and the runtime's globals.
 */
async function runCases(deps: Deps, plan: Plan): Promise<Report> {
  const SECRET = "runtime-secret-key";
  const MIB = 1024 * 1024;
  const outcomes: Record<string, Outcome> = {};
  let globalCalls = 0;
  for (const agent of [deps.http.globalAgent, deps.https.globalAgent]) {
    const spied = agent as unknown as { addRequest: (...args: unknown[]) => unknown };
    const original = spied.addRequest;
    spied.addRequest = function (this: unknown, ...args: unknown[]) {
      globalCalls += 1;
      return original.apply(this, args);
    };
  }
  const kept: Array<{ close(): void }> = [];
  const record = async (
    name: string,
    run: () => Promise<{ status: number; retryAfter: string | null; text: string }>,
  ): Promise<void> => {
    try {
      const response = await run();
      outcomes[name] = {
        ok: true,
        status: response.status,
        retryAfter: response.retryAfter,
        text: response.text.slice(0, 200),
      };
    } catch (error) {
      const failure = error as { name?: string; kind?: string; truncated?: boolean; message?: string };
      outcomes[name] = {
        ok: false,
        errorName: failure.name,
        kind: failure.kind,
        truncated: failure.truncated,
        message: failure.message,
      };
    }
  };
  const material = (ca: string, identity: string) =>
    deps.nodeTlsMaterial({ mode: "verify-full", caCert: ca }, identity);
  const once = async (
    scheme: "http" | "https",
    host: string,
    port: number,
    tls: ReturnType<Deps["nodeTlsMaterial"]>,
    path: string,
    extra: {
      maxResponseBytes?: number;
      signal?: AbortSignal;
      method?: "GET" | "POST";
      body?: string;
      keep?: boolean;
    } = {},
  ) => {
    const origin = deps.httpOrigin(scheme, host, port);
    const transport = deps.createNodeTransport({ origin, tls, maxSockets: 4, headers: { "api-key": SECRET } });
    try {
      return await transport.request({
        method: extra.method ?? "GET",
        url: deps.endpointUrl(origin, path),
        ...(extra.body === undefined ? {} : { body: extra.body }),
        signal: extra.signal ?? AbortSignal.timeout(10_000),
        maxResponseBytes: extra.maxResponseBytes ?? MIB,
      });
    } finally {
      // A kept transport stays open until the socket check below, so a socket it failed to destroy would still be open.
      if (extra.keep === true) kept.push(transport);
      else transport.close();
    }
  };
  const { ports } = plan;

  await record("plaintext request with proxy variables set", () =>
    once("http", "127.0.0.1", ports.plain, null, "/plain"),
  );
  await record("TLS request with proxy variables set", () =>
    once("https", "localhost", ports.secure, material(plan.ca, "localhost"), "/tls"),
  );
  await record("307 to another port", () =>
    once("http", "127.0.0.1", ports.redirecting, null, "/collections/c/points", {
      method: "POST",
      body: '{"points":[]}',
      keep: true,
    }),
  );
  await record("16 MiB answer against an 8 MiB cap", () =>
    once("http", "127.0.0.1", ports.big, null, "/big", { maxResponseBytes: 8 * MIB, keep: true }),
  );
  await record("gzip answer that inflates to 1 GiB", () =>
    once("http", "127.0.0.1", ports.bomb, null, "/bomb", { maxResponseBytes: 8 * MIB, keep: true }),
  );
  await record("a caller's cancel", () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    return once("http", "127.0.0.1", ports.holding, null, "/cancel", { signal: controller.signal, keep: true });
  });
  await record("a deadline", () =>
    once("http", "127.0.0.1", ports.holding, null, "/deadline", { signal: AbortSignal.timeout(100), keep: true }),
  );
  // A body cut before its terminating chunk, by a FIN or an RST, at zero bytes, mid-chunk and at a chunk boundary.
  for (const cut of ["fin", "rst"]) {
    for (const at of ["zero", "mid", "line"]) {
      // oxlint-disable-next-line no-await-in-loop -- one cut at a time, each on its own connection.
      await record(`cut: ${cut} at ${at}`, () => once("http", "127.0.0.1", ports.cut, null, `/${cut}-${at}`));
    }
  }
  // A TLS failure after the status line stays a TLS failure: the truncation reading is for the network branch only.
  await record("TLS: a record corrupted after the headers", () =>
    once("https", "localhost", ports.corrupt, material(plan.ca, "localhost"), "/corrupt"),
  );
  await record("429 with Retry-After 10", () => once("http", "127.0.0.1", ports.retry, null, "/ten"));
  await record("429 with no Retry-After", () => once("http", "127.0.0.1", ports.retry, null, "/none"));
  await record("429 with a 200-character Retry-After", () => once("http", "127.0.0.1", ports.retry, null, "/long"));
  // The TLS matrix of R32 9.
  await record("TLS: localhost with the CA", () =>
    once("https", "localhost", ports.secure, material(plan.ca, "localhost"), "/localhost"),
  );
  await record("TLS: 127.0.0.1 with the CA", () =>
    once("https", "127.0.0.1", ports.secure, material(plan.ca, "127.0.0.1"), "/ip"),
  );
  await record("TLS: a server-name override", () =>
    once("https", "127.0.0.1", ports.secure, material(plan.ca, "localhost"), "/override"),
  );
  await record("TLS: a rogue CA", () =>
    once("https", "localhost", ports.secure, material(plan.rogueCa, "localhost"), "/rogue"),
  );
  await record("TLS: a plaintext listener", () =>
    once("https", "127.0.0.1", ports.plain, material(plan.ca, "127.0.0.1"), "/plaintext"),
  );
  await record("TLS: a wrong name", () =>
    once("https", "localhost", ports.farName, material(plan.ca, "localhost"), "/wrong-name"),
  );
  await record("TLS: two CAs, the second against its own server", () =>
    once("https", "localhost", ports.second, material(plan.secondCa, "localhost"), "/second"),
  );
  await record("TLS: two CAs, the second against the first CA's server", () =>
    once("https", "localhost", ports.secure, material(plan.secondCa, "localhost"), "/second-on-first"),
  );
  await record("TLS: two CAs, the first again after the second", () =>
    once("https", "localhost", ports.secure, material(plan.ca, "localhost"), "/first-again"),
  );
  // A tunnel-shaped connection: the socket dials the local forward, and the certificate must name the far end.
  await record("tunnel: a far end by name", () =>
    once("https", "127.0.0.1", ports.farName, material(plan.ca, "qdrant.test"), "/far-name"),
  );
  await record("tunnel: a far end by address", () =>
    once("https", "127.0.0.1", ports.farAddress, material(plan.ca, "10.0.0.5"), "/far-address"),
  );
  await record("tunnel: checked against the local forward instead", () =>
    once("https", "127.0.0.1", ports.farAddress, material(plan.ca, "127.0.0.1"), "/forward"),
  );
  await record("keep-alive: three at once, then five more, at most two sockets", async () => {
    const origin = deps.httpOrigin("http", "127.0.0.1", ports.slow);
    const transport = deps.createNodeTransport({ origin, tls: null, maxSockets: 2, headers: { "api-key": SECRET } });
    const request = () =>
      transport.request({
        method: "GET",
        url: deps.endpointUrl(origin, "/slow"),
        signal: AbortSignal.timeout(10_000),
        maxResponseBytes: MIB,
      });
    try {
      await Promise.all([request(), request(), request()]);
      let last = await request();
      for (let i = 0; i < 4; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses an idle socket.
        last = await request();
      }
      return last;
    } finally {
      transport.close();
    }
  });
  await record("a request cancelled while queued behind maxSockets", async () => {
    const origin = deps.httpOrigin("http", "127.0.0.1", ports.silent);
    const transport = deps.createNodeTransport({ origin, tls: null, maxSockets: 1, headers: { "api-key": SECRET } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const send = (path: string, signal: AbortSignal) =>
      transport.request({ method: "GET", url: deps.endpointUrl(origin, path), signal, maxResponseBytes: MIB });
    try {
      const [first, queued] = await Promise.allSettled([
        send("/first", AbortSignal.timeout(300)),
        send("/queued", controller.signal),
      ]);
      // Both must fail; the queued one's failure is the outcome, and the parent counts the sockets the listener saw.
      if (first.status === "fulfilled") throw new Error("the first request was answered");
      if (queued.status === "fulfilled") throw new Error("the queued request was answered");
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw queued.reason;
    } finally {
      transport.close();
    }
  });
  // A listed per-request header goes out; an unlisted one is refused before a socket, so the guarded listener sees none.
  const sendHeaders = async (port: number, path: string, headers: Record<string, string>) => {
    const origin = deps.httpOrigin("http", "127.0.0.1", port);
    const transport = deps.createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: { "api-key": SECRET },
      requestHeaderNames: ["x-databend-session"],
    });
    try {
      return await transport.request({
        method: "POST",
        url: deps.endpointUrl(origin, path),
        body: "{}",
        headers,
        signal: AbortSignal.timeout(10_000),
        maxResponseBytes: MIB,
      });
    } finally {
      transport.close();
    }
  };
  await record("request headers: a listed header is sent", () =>
    sendHeaders(ports.plain, "/request-header", { "x-databend-session": "runtime-session" }),
  );
  await record("request headers: an unlisted header is refused before a socket", () =>
    sendHeaders(ports.guarded, "/unlisted", { "x-other": "1" }),
  );
  // Built before the guard is on, so the refusal below is the transport's own and not httpOrigin's.
  const guardedOrigin = deps.httpOrigin("http", "127.0.0.1", ports.guarded);
  process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
  try {
    await record("guard: 127.0.0.1 refused before a socket", async () => {
      kept.push(deps.createNodeTransport({ origin: guardedOrigin, tls: null, maxSockets: 4, headers: {} }));
      return { status: 0, retryAfter: null, text: "built" };
    });
    await record("guard: localhost refused by the lookup on the Agent", () =>
      once("http", "localhost", ports.guarded, null, "/guarded"),
    );
  } finally {
    delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  }
  // Read while every kept transport is still open: the cap, the encoding refusal, the redirect and both stops must
  // have destroyed their sockets themselves.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await record("open sockets on the stopped listeners", () => once("http", "127.0.0.1", ports.plain, null, "/open"));
  const duringCases = globalCalls;
  await new Promise<void>((resolve) => {
    const control = deps.http.request({ hostname: "127.0.0.1", port: ports.plain, path: "/control" }, (answer) => {
      answer.resume();
      answer.on("end", () => resolve());
    });
    control.on("error", () => resolve());
    control.end();
  });
  for (const transport of kept) transport.close();
  // Read off globalThis, so the bundler meets no bare `Bun` identifier in a bundle built for Node.
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return {
    runtime: bun === undefined ? `node ${process.version}` : `bun ${bun.version}`,
    outcomes,
    globalAgentCalls: { duringCases, withControl: globalCalls },
  };
}

/**
 * The byte transport's cases (byte transport design 4.2), run in each child after runCases and its control request.
 * SELF-CONTAINED ON PURPOSE, as runCases is: each child runs this function's own text, so it names nothing but its
 * parameters and the runtime's globals.
 */
async function runByteCases(
  deps: ByteDeps,
  plan: Plan,
): Promise<{ byteOutcomes: Record<string, ByteOutcome>; byteGlobalAgentCalls: number }> {
  const MIB = 1024 * 1024;
  const outcomes: Record<string, ByteOutcome> = {};
  let globalCalls = 0;
  for (const agent of [deps.http.globalAgent, deps.https.globalAgent]) {
    const spied = agent as unknown as { addRequest: (...args: unknown[]) => unknown };
    const original = spied.addRequest;
    spied.addRequest = function (this: unknown, ...args: unknown[]) {
      globalCalls += 1;
      return original.apply(this, args);
    };
  }
  const digest = (bytes: Uint8Array): number => {
    let sum = 0;
    for (const byte of bytes) sum = (Math.imul(sum, 31) + byte) >>> 0;
    return sum;
  };
  const record = async (
    name: string,
    run: () => Promise<{ status: number; bytes: Uint8Array; truncated: boolean; contentEncoding: string | null }>,
  ): Promise<void> => {
    try {
      const answer = await run();
      outcomes[name] = {
        ok: true,
        status: answer.status,
        length: answer.bytes.length,
        digest: digest(answer.bytes),
        truncated: answer.truncated,
        contentEncoding: answer.contentEncoding,
      };
    } catch (error) {
      const failure = error as { name?: string; kind?: string; message?: string; redirect?: unknown };
      outcomes[name] = {
        ok: false,
        errorName: failure.name,
        kind: failure.kind,
        message: failure.message,
        redirect: failure.redirect,
      };
    }
  };
  const connect = (host: string) =>
    deps.createNodeByteTransport({
      origin: deps.httpOrigin("http", host, plan.bytePort),
      tls: null,
      maxSockets: 4,
      headers: {},
      responseHeaders: { names: ["x-amz-bucket-region"] },
    });
  const request = (path: string, extra: { method?: "GET" | "HEAD"; truncateAt?: number } = {}) => ({
    method: extra.method ?? "GET",
    target: { path, query: "" },
    signal: AbortSignal.timeout(10_000),
    maxResponseBytes: 2 * MIB,
    ...(extra.truncateAt === undefined ? {} : { truncateAt: extra.truncateAt }),
  });
  const once = async (host: string, path: string, extra: { truncateAt?: number } = {}) => {
    const transport = connect(host);
    try {
      return await transport.request(request(path, extra));
    } finally {
      transport.close();
    }
  };

  await record("byte: HEAD then GET on one socket", async () => {
    const transport = connect("127.0.0.1");
    try {
      const head = await transport.request(request("/b/head-then-get", { method: "HEAD" }));
      if (head.bytes.length !== 0) throw new Error("the HEAD answer carried a body");
      return await transport.request(request("/b/head-then-get"));
    } finally {
      transport.close();
    }
  });
  await record("byte: truncateAt 100000 of a 1 MiB body", () => once("127.0.0.1", "/b/big", { truncateAt: 100_000 }));
  await record("byte: a dot-segment target", () => once("127.0.0.1", "/b/sp/./dot.txt"));
  await record("byte: a stored gzip body", () => once("127.0.0.1", "/b/gz"));
  await record("byte: a 301 with x-amz-bucket-region", () => once("127.0.0.1", "/b/region"));
  // DB_HTTP_BLOCK_PRIVATE_HOSTS is off here (runCases deletes it, and the child starts without it); entry.mjs
  // answers metadata.test with 169.254.169.254.
  await record("byte: metadata.test with the guard off", () => once("metadata.test", "/b/k"));
  // 5000 requests queued behind one under maxSockets 1, each refused by its signer once the slot frees: a queue that
  // started the next request from inside the last one's failure overflowed the stack on Node past about 1,800 and
  // ended the process. `length` counts the requests that rejected with the signer's own error.
  {
    const transport = deps.createNodeByteTransport({
      origin: deps.httpOrigin("http", "127.0.0.1", plan.bytePort),
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: {
        headerNames: ["authorization"],
        sign: (input) => {
          if (input.path !== "/b/first") throw new Error("expired");
          return { authorization: "signed" };
        },
      },
    });
    try {
      const first = transport.request(request("/b/first"));
      const queued = Array.from({ length: 5000 }, () =>
        transport.request(request("/b/refused")).then(
          () => "sent",
          (error: Error) => error.message,
        ),
      );
      await first;
      const messages = await Promise.all(queued);
      outcomes["byte: 5000 queued requests refused by their signer"] = {
        ok: true,
        length: messages.filter((message) => message === "expired").length,
      };
    } finally {
      transport.close();
    }
  }
  return { byteOutcomes: outcomes, byteGlobalAgentCalls: globalCalls };
}

// -- the listeners ------------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "node-transport-runtimes-"));
const at = (file: string) => join(dir, file);
const HTTP_SOURCES = join(import.meta.dir, "../../../../src/lib/db/http");
const MIB = 1024 * 1024;
const PROXY_VARIABLES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "DB_HTTP_BLOCK_PRIVATE_HOSTS",
]);

let proxy: Listener;
let target: Listener;
let plain: Listener;
let slow: Listener;
let secure: Listener;
let farName: Listener;
let farAddress: Listener;
let redirecting: Listener;
let big: Listener;
let bomb: Listener;
let holding: Listener;
let guarded: Listener;
let silent: Listener;
let cutServer: ReturnType<typeof createTcpServer>;
const cutSockets = new Set<Socket>();
let corruptServer: ReturnType<typeof createTcpServer>;
const corruptSockets = new Set<Socket>();
let byteServer: ReturnType<typeof createTcpServer>;
const byteSockets = new Set<Socket>();
/** Every request line the byte listener received, with the id of the socket it came on, in order. */
const byteHeads: Array<{ readonly socket: number; readonly line: string }> = [];
let byteAccepted = 0;
/** A 1 MiB body of a fixed pattern, so the parent knows the digest of any prefix of it. */
const BYTE_BIG = Buffer.alloc(MIB);
for (let index = 0; index < MIB; index += 1) BYTE_BIG[index] = index % 251;
/** A stored gzip object: 2,000 NDJSON lines, served with content-encoding gzip. */
const BYTE_GZIP = gzipSync(
  Buffer.from(Array.from({ length: 2000 }, (_, index) => `{"line":${index}}\n`).join(""), "utf8"),
);

const CHUNKED = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
/** What the cut listener writes before it cuts, by the path's second half. */
const CUT_BODIES: Readonly<Record<string, string>> = {
  zero: CHUNKED,
  mid: `${CHUNKED}40\r\n0123456789`,
  line: `${CHUNKED}8\r\n{"a":1}\n\r\n`,
};

/**
 * A raw TCP listener that writes a chunked 200 itself and, once the client has read it, cuts the socket with a FIN
 * (`destroy()`) or an RST (`resetAndDestroy()`), as the request path names: /fin-zero, /rst-mid, /fin-line and so on.
 */
async function cutListener(): Promise<number> {
  cutServer = createTcpServer((socket) => {
    cutSockets.add(socket);
    socket.on("close", () => cutSockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const [cut, at] = head.split(" ")[1].slice(1).split("-");
      socket.write(CUT_BODIES[at], () =>
        setTimeout(() => (cut === "fin" ? socket.destroy() : socket.resetAndDestroy()), 30),
      );
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => cutServer.listen(0, "127.0.0.1", resolve));
  return (cutServer.address() as AddressInfo).port;
}

/**
 * A raw TCP listener that runs TLS itself over each socket, answers a chunked 200 through it and, once the client has
 * read it, writes bytes that are no TLS record onto the TCP socket underneath, so the client's TLS layer fails after
 * the status line.
 */
async function corruptListener(material: { readonly cert: string; readonly key: string }): Promise<number> {
  corruptServer = createTcpServer((raw) => {
    corruptSockets.add(raw);
    raw.on("close", () => corruptSockets.delete(raw));
    raw.on("error", () => {});
    const secured = new TLSSocket(raw, { isServer: true, cert: material.cert, key: material.key });
    secured.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      secured.off("data", onData);
      secured.write(CHUNKED, () => setTimeout(() => raw.write(Buffer.alloc(64, 0x17)), 30));
    };
    secured.on("data", onData);
  });
  await new Promise<void>((resolve) => corruptServer.listen(0, "127.0.0.1", resolve));
  return (corruptServer.address() as AddressInfo).port;
}

/** The byte cases' answers, by method and path. */
function byteAnswer(method: string, path: string): Buffer {
  const answer = (status: string, headers: readonly string[], body: Buffer = Buffer.alloc(0)): Buffer =>
    Buffer.concat([
      Buffer.from(`HTTP/1.1 ${status}\r\n${headers.map((line) => `${line}\r\n`).join("")}\r\n`, "latin1"),
      body,
    ]);
  if (path === "/b/head-then-get" && method === "HEAD") return answer("200 OK", ["content-length: 1000"]);
  if (path === "/b/head-then-get") return answer("200 OK", ["content-length: 2"], Buffer.from("ok"));
  if (path === "/b/big") return answer("200 OK", [`content-length: ${MIB}`], BYTE_BIG);
  if (path === "/b/sp/./dot.txt") return answer("200 OK", ["content-length: 3"], Buffer.from("dot"));
  if (path === "/b/gz") {
    return answer("200 OK", ["content-encoding: gzip", `content-length: ${BYTE_GZIP.length}`], BYTE_GZIP);
  }
  if (path === "/b/region") {
    return answer("301 Moved Permanently", ["x-amz-bucket-region: eu-west-1", "content-length: 0"]);
  }
  return answer("404 Not Found", ["content-length: 0"]);
}

/**
 * A raw TCP listener for the byte cases: it records each request line byte for byte with its socket's id, so a reused
 * socket can be told from a new one, and answers by method and path, keeping the socket open.
 */
async function byteListener(): Promise<number> {
  byteServer = createTcpServer((socket) => {
    byteAccepted += 1;
    const id = byteAccepted;
    byteSockets.add(socket);
    socket.on("close", () => byteSockets.delete(socket));
    socket.on("error", () => {});
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      for (let end = pending.indexOf("\r\n\r\n"); end !== -1; end = pending.indexOf("\r\n\r\n")) {
        const line = pending.slice(0, pending.indexOf("\r\n"));
        pending = pending.slice(end + 4);
        byteHeads.push({ socket: id, line });
        const [method, path] = line.split(" ");
        if (!socket.destroyed) socket.write(byteAnswer(method, path));
      }
    });
  });
  await new Promise<void>((resolve) => byteServer.listen(0, "127.0.0.1", resolve));
  return (byteServer.address() as AddressInfo).port;
}

beforeAll(async () => {
  const certificates = makeCertificates();
  const bombBody = await gzipOfZeros(1024 * MIB);
  proxy = await countingListener();
  target = await httpListener(jsonAnswer(200, "{}"));
  plain = await httpListener((request, response, body) => {
    const text =
      request.url === "/open"
        ? JSON.stringify({
            big: big.open(),
            bomb: bomb.open(),
            holding: holding.open(),
            redirecting: redirecting.open(),
          })
        : '{"result":"plain"}';
    jsonAnswer(200, text)(request, response, body);
  });
  slow = await httpListener((request, response, body) => {
    setTimeout(() => jsonAnswer(200, "{}")(request, response, body), 30);
  });
  secure = await httpsListener(certificates.local, jsonAnswer(200, "{}"));
  const second = await httpsListener(certificates.second, jsonAnswer(200, "{}"));
  farName = await httpsListener(certificates.farName, jsonAnswer(200, "{}"));
  farAddress = await httpsListener(certificates.farAddress, jsonAnswer(200, "{}"));
  redirecting = await httpListener((_request, response) => {
    response.writeHead(307, {
      location: `http://127.0.0.1:${target.port}/collections/c/points?api-key=redirect-secret`,
    });
    response.end("moved");
  });
  big = await httpListener(streamingAnswer(16 * MIB));
  bomb = await httpListener((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(bombBody);
  });
  holding = await httpListener(() => {});
  const retry = await httpListener((request, response, body) => {
    const headers: Record<string, string> =
      request.url === "/ten"
        ? { "retry-after": "10" }
        : request.url === "/long"
          ? { "retry-after": "7".repeat(200) }
          : {};
    jsonAnswer(429, '{"status":{"error":"rate limited"}}', headers)(request, response, body);
  });
  guarded = await httpListener(jsonAnswer(200, "{}"));
  silent = await silentListener();
  const cutPort = await cutListener();
  const corruptPort = await corruptListener(certificates.local);
  const bytePort = await byteListener();
  const plan: Plan = {
    ports: {
      plain: plain.port,
      slow: slow.port,
      secure: secure.port,
      second: second.port,
      farName: farName.port,
      farAddress: farAddress.port,
      redirecting: redirecting.port,
      big: big.port,
      bomb: bomb.port,
      holding: holding.port,
      retry: retry.port,
      guarded: guarded.port,
      silent: silent.port,
      cut: cutPort,
      corrupt: corruptPort,
    },
    ca: certificates.ca,
    rogueCa: certificates.rogueCa,
    secondCa: certificates.secondCa,
    bytePort,
  };
  writeFileSync(at("plan.json"), JSON.stringify(plan));
  // The child runs a bundle of the transport's own modules around the text of `runCases`, because Node loads neither
  // TypeScript with `@/` imports nor this file, which is a bun:test file.
  writeFileSync(
    at("child.ts"),
    [
      'import http from "node:http";',
      'import https from "node:https";',
      'import { readFileSync } from "node:fs";',
      `import { createNodeTransport, nodeTlsMaterial } from ${JSON.stringify(join(HTTP_SOURCES, "node-transport.ts"))};`,
      `import { endpointUrl, httpOrigin } from ${JSON.stringify(join(HTTP_SOURCES, "endpoint.ts"))};`,
      `import { createNodeByteTransport } from ${JSON.stringify(join(HTTP_SOURCES, "node-transport.ts"))};`,
      `const runCases = ${runCases.toString()};`,
      `const runByteCases = ${runByteCases.toString()};`,
      'const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      "const report = await runCases({ createNodeTransport, nodeTlsMaterial, endpointUrl, httpOrigin, http, https }, plan);",
      "Object.assign(report, await runByteCases({ createNodeByteTransport, httpOrigin, http, https }, plan));",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  // Unbundled on purpose: the bundle hoists its node:dns import, so on Bun a patch inside child.ts would land too late
  // (patched after the import, Bun 1.4.2 still resolved the real name; patched before it, Node and Bun both saw the
  // patch). This answers metadata.test with 169.254.169.254 itself, asking no resolver, hands every other name to the
  // real lookup, and syncBuiltinESMExports makes the bundle's `import { lookup } from "node:dns"` see the patch.
  writeFileSync(
    at("entry.mjs"),
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'const dns = createRequire(import.meta.url)("node:dns");',
      "const original = dns.lookup;",
      "dns.lookup = function lookup(hostname, options, callback) {",
      '  if (hostname !== "metadata.test") return original.call(this, hostname, options, callback);',
      '  const done = typeof options === "function" ? options : callback;',
      '  const all = typeof options === "object" && options !== null && options.all === true;',
      '  const answer = { address: "169.254.169.254", family: 4 };',
      "  process.nextTick(() => (all ? done(null, [answer]) : done(null, answer.address, answer.family)));",
      "};",
      "syncBuiltinESMExports();",
      'await import("./child.js");',
      "",
    ].join("\n"),
  );
}, 60_000);

afterAll(async () => {
  await closeAll();
  for (const socket of cutSockets) socket.destroy();
  await new Promise<void>((resolve) => cutServer.close(() => resolve()));
  for (const socket of corruptSockets) socket.destroy();
  await new Promise<void>((resolve) => corruptServer.close(() => resolve()));
  for (const socket of byteSockets) socket.destroy();
  await new Promise<void>((resolve) => byteServer.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

// -- the children and what each must report -----------------------------------------------------------------------

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROXY_VARIABLES.has(name)) environment[name] = value;
  }
  const address = `http://127.0.0.1:${proxy.port}`;
  return {
    ...environment,
    HTTP_PROXY: address,
    HTTPS_PROXY: address,
    http_proxy: address,
    https_proxy: address,
    ALL_PROXY: address,
    all_proxy: address,
    NODE_USE_ENV_PROXY: "1",
  };
}

interface Counts {
  readonly proxy: number;
  readonly target: number;
  readonly slow: number;
  readonly guarded: number;
  readonly silent: number;
}

const counts = (): Counts => ({
  proxy: proxy.accepted(),
  target: target.accepted(),
  slow: slow.accepted(),
  guarded: guarded.accepted(),
  silent: silent.accepted(),
});

interface ChildRun {
  readonly report: Report;
  readonly delta: Counts;
  /** Index into each listener's `seen` where this child's requests start. */
  readonly from: {
    readonly plain: number;
    readonly secure: number;
    readonly farName: number;
    readonly farAddress: number;
    readonly byteHeads: number;
  };
}

async function runChild(binary: string): Promise<ChildRun> {
  const before = counts();
  const from = {
    plain: plain.seen.length,
    secure: secure.seen.length,
    farName: farName.seen.length,
    farAddress: farAddress.seen.length,
    byteHeads: byteHeads.length,
  };
  const child = Bun.spawn([binary, at("entry.mjs"), at("plan.json")], {
    cwd: dir,
    env: childEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line === "") throw new Error(`The child ${binary} printed nothing: ${stderr}`);
  const after = counts();
  return {
    report: JSON.parse(line) as Report,
    delta: {
      proxy: after.proxy - before.proxy,
      target: after.target - before.target,
      slow: after.slow - before.slow,
      guarded: after.guarded - before.guarded,
      silent: after.silent - before.silent,
    },
    from,
  };
}

const TLS_FAILURE = /^The TLS connection failed \([A-Z][A-Z0-9_]*\)$/;
const BLOCKED = "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";

type Expected =
  | { readonly ok: true; readonly status: number; readonly retryAfter?: string | null }
  | {
      readonly ok: false;
      readonly errorName: string;
      readonly kind?: string;
      readonly truncated?: boolean;
      readonly message: string | RegExp;
    };

const OK: Expected = { ok: true, status: 200 };
const TLS_REFUSED: Expected = { ok: false, errorName: "TransportError", kind: "tls", message: TLS_FAILURE };
const TRUNCATED: Expected = {
  ok: false,
  errorName: "TransportError",
  kind: "network",
  truncated: true,
  message: "The server ended the response before it was complete",
};

const EXPECTED: Readonly<Record<string, Expected>> = {
  "plaintext request with proxy variables set": OK,
  "TLS request with proxy variables set": OK,
  "307 to another port": {
    ok: false,
    errorName: "TransportError",
    kind: "redirect",
    message: /^The server answered HTTP 307, a redirect to http:\/\/127\.0\.0\.1:\d+, and redirects are not followed$/,
  },
  "16 MiB answer against an 8 MiB cap": {
    ok: false,
    errorName: "TransportError",
    kind: "too-large",
    message: "The response exceeded the 8388608-byte limit for one response, so it was not read to the end",
  },
  "gzip answer that inflates to 1 GiB": {
    ok: false,
    errorName: "TransportError",
    kind: "encoding",
    message:
      "The server answered with content-encoding gzip, and this transport reads identity only, so the response was not read",
  },
  "a caller's cancel": {
    ok: false,
    errorName: "TransportError",
    kind: "aborted",
    message: "The request was cancelled",
  },
  "a deadline": {
    ok: false,
    errorName: "TransportError",
    kind: "timeout",
    message: "The request did not finish within its time limit",
  },
  "cut: fin at zero": TRUNCATED,
  "cut: fin at mid": TRUNCATED,
  "cut: fin at line": TRUNCATED,
  "cut: rst at zero": TRUNCATED,
  "cut: rst at mid": TRUNCATED,
  "cut: rst at line": TRUNCATED,
  // Bun reports this cut as ECONNRESET with no TLS code on either object, so only the network branch is left for it.
  "TLS: a record corrupted after the headers": TRUNCATED,
  "429 with Retry-After 10": { ok: true, status: 429, retryAfter: "10" },
  "429 with no Retry-After": { ok: true, status: 429, retryAfter: null },
  "429 with a 200-character Retry-After": { ok: true, status: 429, retryAfter: "7".repeat(64) },
  "TLS: localhost with the CA": OK,
  "TLS: 127.0.0.1 with the CA": OK,
  "TLS: a server-name override": OK,
  "TLS: a rogue CA": TLS_REFUSED,
  "TLS: a plaintext listener": TLS_REFUSED,
  "TLS: a wrong name": TLS_REFUSED,
  "TLS: two CAs, the second against its own server": OK,
  "TLS: two CAs, the second against the first CA's server": TLS_REFUSED,
  "TLS: two CAs, the first again after the second": OK,
  "tunnel: a far end by name": OK,
  "tunnel: a far end by address": OK,
  "tunnel: checked against the local forward instead": TLS_REFUSED,
  "keep-alive: three at once, then five more, at most two sockets": OK,
  "a request cancelled while queued behind maxSockets": {
    ok: false,
    errorName: "TransportError",
    kind: "aborted",
    message: "The request was cancelled",
  },
  "request headers: a listed header is sent": OK,
  "request headers: an unlisted header is refused before a socket": {
    ok: false,
    errorName: "DatabaseConfigError",
    message: "Invalid request headers: a header this transport does not list was given",
  },
  "guard: 127.0.0.1 refused before a socket": { ok: false, errorName: "DatabaseConfigError", message: BLOCKED },
  "guard: localhost refused by the lookup on the Agent": {
    ok: false,
    errorName: "DatabaseConfigError",
    message: BLOCKED,
  },
  "open sockets on the stopped listeners": OK,
};

/**
 * Where Node differs: its request emits the TLS layer's own code (ERR_SSL_WRONG_VERSION_NUMBER) before the answer's
 * ECONNRESET, and a TLS code stays kind "tls" with `truncated: false` even after the response callback ran.
 */
const EXPECTED_ON_NODE: Readonly<Record<string, Expected>> = {
  "TLS: a record corrupted after the headers": TLS_REFUSED,
};

const LINK_LOCAL =
  "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says";

/** The digest runByteCases computes, written again here, where each expected answer's digest is computed. */
function byteDigest(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum = (Math.imul(sum, 31) + byte) >>> 0;
  return sum;
}

/** What each byte case must come to on every runtime. */
const BYTE_EXPECTED: Readonly<Record<string, ByteOutcome>> = {
  "byte: HEAD then GET on one socket": {
    ok: true,
    status: 200,
    length: 2,
    digest: byteDigest(Buffer.from("ok")),
    truncated: false,
    contentEncoding: null,
  },
  "byte: truncateAt 100000 of a 1 MiB body": {
    ok: true,
    status: 200,
    length: 100_000,
    digest: byteDigest(BYTE_BIG.subarray(0, 100_000)),
    truncated: true,
    contentEncoding: null,
  },
  "byte: a dot-segment target": {
    ok: true,
    status: 200,
    length: 3,
    digest: byteDigest(Buffer.from("dot")),
    truncated: false,
    contentEncoding: null,
  },
  "byte: a stored gzip body": {
    ok: true,
    status: 200,
    length: BYTE_GZIP.length,
    digest: byteDigest(BYTE_GZIP),
    truncated: false,
    contentEncoding: "gzip",
  },
  "byte: a 301 with x-amz-bucket-region": {
    ok: false,
    errorName: "TransportError",
    kind: "redirect",
    message: "The server answered HTTP 301, a redirect with no Location header, and redirects are not followed",
    redirect: { status: 301, headers: [["x-amz-bucket-region", "eu-west-1"]], headersTruncated: false },
  },
  "byte: metadata.test with the guard off": { ok: false, errorName: "DatabaseConfigError", message: LINK_LOCAL },
  "byte: 5000 queued requests refused by their signer": { ok: true, length: 5000 },
};

function expectCase(report: Report | undefined, name: string): void {
  const outcome = report?.outcomes[name];
  const expected =
    (report?.runtime.startsWith("node ") === true ? EXPECTED_ON_NODE[name] : undefined) ?? EXPECTED[name];
  if (expected.ok) {
    expect({ name, ok: outcome?.ok, status: outcome?.status, message: outcome?.message }).toEqual({
      name,
      ok: true,
      status: expected.status,
      message: undefined,
    });
    if (expected.retryAfter !== undefined) expect(outcome?.retryAfter).toBe(expected.retryAfter);
    return;
  }
  expect({
    name,
    ok: outcome?.ok,
    errorName: outcome?.errorName,
    kind: outcome?.kind,
    truncated: outcome?.truncated,
  }).toEqual({
    name,
    ok: false,
    errorName: expected.errorName,
    kind: expected.kind,
    // Every TransportError carries the flag, true only for a cut body; a configuration refusal carries none.
    truncated: expected.truncated ?? (expected.errorName === "TransportError" ? false : undefined),
  });
  if (typeof expected.message === "string") expect(outcome?.message).toBe(expected.message);
  else expect(outcome?.message).toMatch(expected.message);
  expect(outcome?.message).not.toContain("secret");
}

/** The runtime string a child of `binary` must report: Bun's own version, or what the Node binary prints. */
function expectedRuntime(binary: string): string {
  if (binary === process.execPath) return `bun ${Bun.version}`;
  const printed = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (printed.exitCode !== 0) throw new Error(`${binary} --version exited ${printed.exitCode}`);
  return `node ${printed.stdout.toString().trim()}`;
}

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; an empty list or no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  if (listed !== undefined) {
    const binaries = listed.split(delimiter).filter((entry) => entry !== "");
    if (binaries.length === 0) throw new Error("NODE_TRANSPORT_NODES is set and lists no Node binary");
    return binaries;
  }
  const onPath = Bun.which("node");
  if (onPath === null) {
    throw new Error(
      "No node on PATH: this file runs the cases under Node, the production runtime; install Node 24 or later",
    );
  }
  return [onPath];
}

const RUNTIMES: ReadonlyArray<readonly [string, string]> = [
  ["a Bun child", process.execPath],
  ...nodeBinaries().map((binary) => [`a Node child, ${binary}`, binary] as const),
];

for (const [label, binary] of RUNTIMES) {
  describe(`in ${label}`, () => {
    let run: ChildRun | undefined;
    beforeAll(async () => {
      run = await runChild(binary);
      console.log(`node-transport runtimes: ${label} ran as ${run.report.runtime}`);
    }, 120_000);

    test("the child ran on the runtime it was asked for", () => {
      expect(run?.report.runtime).toBe(expectedRuntime(binary));
    });

    test.each(Object.keys(EXPECTED))("%s", (name) => expectCase(run?.report, name));

    test("the proxy variables named a counting listener that saw only the control request", () => {
      expect(run?.delta.proxy).toBe(1);
      expect(plain.seen.slice(run?.from.plain).map(({ url }) => url)).not.toContain("/control");
    });

    test("the global agents carried nothing but the control request", () => {
      expect(run?.report.globalAgentCalls).toEqual({ duringCases: 0, withControl: 1 });
    });

    test("the redirect's target and the guarded listener saw nothing", () => {
      expect(run?.delta.target).toBe(0);
      expect(run?.delta.guarded).toBe(0);
    });

    test("a listed per-request header reached the listener under its listed name", () => {
      const sent = plain.seen.slice(run?.from.plain).find(({ url }) => url === "/request-header");
      expect(sent?.headers["x-databend-session"]).toBe("runtime-session");
    });

    test("keep-alive used two sockets for eight requests", () => {
      expect(run?.delta.slow).toBe(2);
    });

    test("a request cancelled while queued behind maxSockets opened no socket", () => {
      expect(run?.delta.silent).toBe(1);
    });

    test("every request carried accept-encoding identity", () => {
      const seen = [...plain.seen.slice(run?.from.plain), ...secure.seen.slice(run?.from.secure)];
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(({ headers }) => headers["accept-encoding"] === "identity")).toBe(true);
    });

    test("a DNS identity is sent as the server name, and an IP identity sends none", () => {
      const servername = (listener: Listener, from: number | undefined, url: string) =>
        listener.seen.slice(from).find((entry) => entry.url === url)?.servername;
      expect(servername(secure, run?.from.secure, "/localhost")).toBe("localhost");
      expect(servername(secure, run?.from.secure, "/ip")).toBe(false);
      expect(servername(secure, run?.from.secure, "/override")).toBe("localhost");
      expect(servername(farName, run?.from.farName, "/far-name")).toBe("qdrant.test");
      expect(servername(farAddress, run?.from.farAddress, "/far-address")).toBe(false);
    });

    test("the cap, the encoding refusal, the redirect and both stops destroyed their sockets while their transports stayed open", () => {
      const text = run?.report.outcomes["open sockets on the stopped listeners"]?.text ?? "null";
      expect(JSON.parse(text)).toEqual({ big: 0, bomb: 0, holding: 0, redirecting: 0 });
    });

    test.each(Object.keys(BYTE_EXPECTED))("%s", (name) => {
      expect({ name, outcome: byteReport(run)?.byteOutcomes[name] }).toEqual({ name, outcome: BYTE_EXPECTED[name] });
    });

    test("the byte cases sent nothing through the global agents", () => {
      expect(byteReport(run)?.byteGlobalAgentCalls).toBe(0);
    });

    test("the byte HEAD and GET shared one socket, and the dot-segment target arrived byte for byte", () => {
      const heads = byteHeads.slice(run?.from.byteHeads);
      const headThenGet = heads.filter(({ line }) => line.endsWith(" /b/head-then-get HTTP/1.1"));
      expect(headThenGet.map(({ line }) => line)).toEqual([
        "HEAD /b/head-then-get HTTP/1.1",
        "GET /b/head-then-get HTTP/1.1",
      ]);
      expect(new Set(headThenGet.map(({ socket }) => socket)).size).toBe(1);
      expect(heads.map(({ line }) => line)).toContain("GET /b/sp/./dot.txt HTTP/1.1");
    });
  });
}
