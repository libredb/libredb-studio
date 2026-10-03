/**
 * The transport's proxy, redirect, cap, encoding, Retry-After, TLS, tunnel, pooling and guard checks on the runtimes
 * production runs (vector-family spec 3.7 and 8.2): in a Bun child and in one Node child per binary that
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
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import type * as https from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  | "silent";

interface Plan {
  readonly ports: Readonly<Record<PortName, number>>;
  readonly ca: string;
  readonly rogueCa: string;
  readonly secondCa: string;
}

interface Outcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly retryAfter?: string | null;
  readonly text?: string;
  readonly errorName?: string;
  readonly kind?: string;
  readonly message?: string;
}

interface Report {
  readonly runtime: string;
  readonly outcomes: Record<string, Outcome>;
  readonly globalAgentCalls: { readonly duringCases: number; readonly withControl: number };
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
      const failure = error as { name?: string; kind?: string; message?: string };
      outcomes[name] = { ok: false, errorName: failure.name, kind: failure.kind, message: failure.message };
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
    },
    ca: certificates.ca,
    rogueCa: certificates.rogueCa,
    secondCa: certificates.secondCa,
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
      `const runCases = ${runCases.toString()};`,
      'const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      "const report = await runCases({ createNodeTransport, nodeTlsMaterial, endpointUrl, httpOrigin, http, https }, plan);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(async () => {
  await closeAll();
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
  };
}

async function runChild(binary: string): Promise<ChildRun> {
  const before = counts();
  const from = {
    plain: plain.seen.length,
    secure: secure.seen.length,
    farName: farName.seen.length,
    farAddress: farAddress.seen.length,
  };
  const child = Bun.spawn([binary, at("child.js"), at("plan.json")], {
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
  | { readonly ok: false; readonly errorName: string; readonly kind?: string; readonly message: string | RegExp };

const OK: Expected = { ok: true, status: 200 };
const TLS_REFUSED: Expected = { ok: false, errorName: "TransportError", kind: "tls", message: TLS_FAILURE };

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
  "guard: 127.0.0.1 refused before a socket": { ok: false, errorName: "DatabaseConfigError", message: BLOCKED },
  "guard: localhost refused by the lookup on the Agent": {
    ok: false,
    errorName: "DatabaseConfigError",
    message: BLOCKED,
  },
  "open sockets on the stopped listeners": OK,
};

function expectCase(report: Report | undefined, name: string): void {
  const outcome = report?.outcomes[name];
  const expected = EXPECTED[name];
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
  expect({ name, ok: outcome?.ok, errorName: outcome?.errorName, kind: outcome?.kind }).toEqual({
    name,
    ok: false,
    errorName: expected.errorName,
    kind: expected.kind,
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
  });
}
