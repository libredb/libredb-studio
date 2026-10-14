/**
 * Real handshakes and a real cancel through the shared gRPC transport, each status mapped by toSparkError,
 * under Bun and in a Node child, the production runtime, so a change of grpc-js's or a runtime's text fails
 * here. The certificates are tests/fixtures/tls. `openssl s_server` stands in for a TLS proxy that requires a client
 * certificate trusted through the unrelated CA, and refuses a missing or an untrusted one with a TLS alert; a grpc-js
 * server only closes the connection on an untrusted one. Under Bun no alert reaches the status text, which says
 * "Failed to connect", so both alert cases read as not-connected there. The certificate dates are pinned in
 * errors.test.ts only: the fixtures hold no expired certificate, and no CA key to sign one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { SPARK_ERROR_SENTENCES, type SparkErrorCategory, toSparkError } from "@/lib/db/providers/sql/spark/errors";
import {
  runSparkHandshakeCases,
  SPARK_STUB_METHOD,
  type SparkHandshakeCase,
  type SparkHandshakeOutcome,
} from "../../../helpers/spark-handshake-cases";
import { loadTlsFixtures, type TlsFixtures } from "../../../helpers/tls-fixtures";

const HELPER = join(import.meta.dir, "../../../helpers/spark-handshake-cases.ts");
const TIMEOUT = 3000;

let fixtures: TlsFixtures;
let work: string;
const servers: grpc.Server[] = [];
const listeners: http.Server[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
let ports: Record<"tls" | "plaintext" | "alerting" | "http1", number>;

/** Answers an empty request, and never a non-empty one, which only its client's cancel ends. */
async function stubServer(serverCredentials: grpc.ServerCredentials): Promise<number> {
  const server = new grpc.Server();
  server.addService(
    { Config: SPARK_STUB_METHOD },
    {
      Config: (call: grpc.ServerUnaryCall<Uint8Array, Uint8Array>, callback: grpc.sendUnaryData<Uint8Array>) => {
        if (call.request.length === 0) callback(null, new Uint8Array(0));
      },
    },
  );
  servers.push(server);
  return new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", serverCredentials, (error, port) => (error ? reject(error) : resolve(port))),
  );
}

/** openssl s_server over TLS 1.3, requiring a client certificate the unrelated CA signed; it answers no gRPC. */
async function alertingServer(): Promise<number> {
  if (Bun.which("openssl") === null) {
    throw new Error("No openssl on PATH: openssl s_server stands in for the alerting TLS proxy; install OpenSSL");
  }
  writeFileSync(join(work, "server.crt"), fixtures.server.cert);
  writeFileSync(join(work, "server.key"), fixtures.server.key);
  writeFileSync(join(work, "other-ca.crt"), fixtures.otherCa);
  writeFileSync(join(work, "openssl.cnf"), "");
  const server = Bun.spawn(
    [
      "openssl",
      "s_server",
      "-accept",
      "127.0.0.1:0",
      "-cert",
      "server.crt",
      "-key",
      "server.key",
      "-CAfile",
      "other-ca.crt",
      "-Verify",
      "1",
      "-verify_return_error",
      "-tls1_3",
      "-alpn",
      "h2",
      "-www",
    ],
    {
      cwd: work,
      env: { ...process.env, OPENSSL_CONF: join(work, "openssl.cnf") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  processes.push(server);
  const reader = server.stdout.getReader();
  const listening = /^ACCEPT \S+:(\d+)$/m;
  let printed = "";
  let ended = false;
  while (!ended && !listening.test(printed)) {
    // oxlint-disable-next-line no-await-in-loop -- s_server prints ACCEPT once it listens.
    const { done, value } = await reader.read();
    ended = done;
    if (value !== undefined) printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = listening.exec(printed)?.[1];
  if (port === undefined) throw new Error(`openssl s_server printed no port: ${printed}`);
  return Number(port);
}

/** A plain HTTP/1.1 server, as the Spark driver UI on 4040 is. */
async function http1Server(): Promise<number> {
  const listener = http.createServer((_request, response) => response.end("not gRPC"));
  listeners.push(listener);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return (listener.address() as AddressInfo).port;
}

beforeAll(async () => {
  fixtures = loadTlsFixtures();
  work = mkdtempSync(join(tmpdir(), "spark-handshake-"));
  ports = {
    tls: await stubServer(
      grpc.ServerCredentials.createSsl(null, [
        { private_key: Buffer.from(fixtures.server.key), cert_chain: Buffer.from(fixtures.server.cert) },
      ]),
    ),
    plaintext: await stubServer(grpc.ServerCredentials.createInsecure()),
    alerting: await alertingServer(),
    http1: await http1Server(),
  };
}, 60_000);

afterAll(async () => {
  for (const server of servers) server.forceShutdown();
  for (const listener of listeners) listener.close();
  for (const child of processes) child.kill();
  await Promise.all(processes.map((child) => child.exited));
  rmSync(work, { recursive: true, force: true });
});

function cases(): SparkHandshakeCase[] {
  const tls = (identity: string, extra: Partial<NonNullable<SparkHandshakeCase["tls"]>> = {}) => ({
    tls: { mode: "verify-full" as const, ca: fixtures.ca, identity, ...extra },
  });
  return [
    { name: "the certificate names the host", port: ports.tls, ...tls("localhost"), timeoutMs: TIMEOUT },
    { name: "a certificate that does not name the host", port: ports.tls, ...tls("spark.example"), timeoutMs: TIMEOUT },
    { name: "a certificate that does not list the IP", port: ports.tls, ...tls("10.0.0.5"), timeoutMs: TIMEOUT },
    {
      name: "verify-ca checks the name as verify-full does",
      port: ports.tls,
      ...tls("spark.example", { mode: "verify-ca" }),
      timeoutMs: TIMEOUT,
    },
    {
      name: "no client certificate where the proxy requires one",
      port: ports.alerting,
      ...tls("localhost"),
      timeoutMs: TIMEOUT,
    },
    {
      name: "a client certificate from a CA the proxy does not trust",
      port: ports.alerting,
      ...tls("localhost", { clientCertificate: fixtures.client }),
      timeoutMs: TIMEOUT,
    },
    { name: "plaintext to a port that answers HTTP/1.1", port: ports.http1, timeoutMs: TIMEOUT },
    { name: "plaintext to a TLS port", port: ports.tls, timeoutMs: TIMEOUT },
    { name: "the client's own cancel", port: ports.plaintext, cancelAfterMs: 200, timeoutMs: TIMEOUT },
  ];
}

type Runtime = "bun" | "node";
type Mapped = { readonly category: SparkErrorCategory; readonly message: string };
/** One mapping, or the mappings a case may read as where the runtime's text varies by platform. */
type Expected = "answered" | Mapped | readonly Mapped[];

/** What each case maps to; `host` and `port` are what the sentence names. */
function expected(item: SparkHandshakeCase, runtime: Runtime): Expected {
  const S = SPARK_ERROR_SENTENCES;
  const host = item.tls?.identity ?? "127.0.0.1";
  const notConnected = { category: "not-connected", message: S.notConnected(host, item.port) } as const;
  switch (item.name) {
    case "a certificate that does not name the host":
    case "a certificate that does not list the IP":
    case "verify-ca checks the name as verify-full does":
      return { category: "tls", message: S.tlsNameMismatch(host) };
    case "no client certificate where the proxy requires one":
      return runtime === "node" ? { category: "tls", message: S.tlsClientCertificateRequired } : notConnected;
    case "a client certificate from a CA the proxy does not trust":
      return runtime === "node" ? { category: "tls", message: S.tlsClientCertificateRefused } : notConnected;
    // Under Node on Windows this case read as not-connected (measured on windows-latest, Node 24.21.0): grpc-js named
    // no cause there, as it names none for a TLS port. Bun on Windows and Node on Linux and macOS read the answer.
    case "plaintext to a port that answers HTTP/1.1": {
      const portExpected = { category: "tls", message: S.tlsPortExpected(host, item.port) } as const;
      return runtime === "node" && process.platform === "win32" ? [portExpected, notConnected] : portExpected;
    }
    // A TLS server that closes on plaintext bytes leaves grpc-js "Failed to connect", which names no cause.
    case "plaintext to a TLS port":
      return notConnected;
    case "the client's own cancel":
      return { category: "cancelled", message: S.cancelled };
    default:
      return "answered";
  }
}

function expectRun(outcomes: readonly SparkHandshakeOutcome[], runtime: Runtime): void {
  const items = cases();
  expect(outcomes.map((outcome) => outcome.name)).toEqual(items.map((item) => item.name));
  for (const [index, item] of items.entries()) {
    const outcome = outcomes[index];
    const want = expected(item, runtime);
    if (want === "answered") {
      expect(outcome).toStrictEqual({ name: item.name, outcome: "answered" });
      continue;
    }
    if (outcome.outcome !== "failed") throw new Error(`${item.name}: ${outcome.outcome}, not a gRPC status`);
    const status = Object.assign(new Error(outcome.details), { code: outcome.code, details: outcome.details });
    const phase = item.cancelAfterMs === undefined ? "connect" : "relation";
    const error = toSparkError(status, {
      connection: { host: item.tls?.identity ?? "127.0.0.1", port: item.port, secretForms: [] },
      phase,
      timeoutMs: TIMEOUT,
    });
    const mapped = { name: item.name, category: error.category, message: error.message };
    if ("category" in want) expect(mapped).toStrictEqual({ name: item.name, ...want });
    else expect(want).toContainEqual({ category: mapped.category, message: mapped.message });
  }
  const raw = (name: string) =>
    outcomes.find((outcome) => outcome.name === name) as { code?: number; details?: string };
  // grpc-js's own text for its client's cancel (call.ts cancel()), the one CANCELLED text that is the user's.
  expect(raw("the client's own cancel")).toMatchObject({ code: 1, details: "Cancelled on client" });
  if (runtime === "bun") {
    expect(raw("no client certificate where the proxy requires one").details).toContain("Failed to connect");
    expect(raw("a client certificate from a CA the proxy does not trust").details).toContain("Failed to connect");
  }
}

describe("under Bun", () => {
  let outcomes: SparkHandshakeOutcome[] = [];
  beforeAll(async () => {
    outcomes = await runSparkHandshakeCases(cases());
  }, 60_000);

  test("every case maps to its sentence", () => expectRun(outcomes, "bun"));
});

describe("in a Node child, the production runtime", () => {
  let outcomes: SparkHandshakeOutcome[] = [];
  let version = "";
  beforeAll(async () => {
    const node = Bun.which("node");
    if (node === null)
      throw new Error("No node on PATH: this block runs every case under Node; install Node 24 or later");
    writeFileSync(
      join(work, "child.ts"),
      [
        'import { readFileSync } from "node:fs";',
        `import { runSparkHandshakeCases } from ${JSON.stringify(HELPER)};`,
        'const outcomes = await runSparkHandshakeCases(JSON.parse(readFileSync(process.argv[2], "utf8")));',
        'process.stdout.write(JSON.stringify({ version: process.version, outcomes }) + "\\n");',
        "",
      ].join("\n"),
    );
    const build = await Bun.build({
      entrypoints: [join(work, "child.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
    writeFileSync(join(work, "cases.json"), JSON.stringify(cases()));
    const child = Bun.spawn([node, join(work, "child.js"), join(work, "cases.json")], {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The Node child exited ${exitCode}: ${stderr}`);
    ({ version, outcomes } = JSON.parse(stdout.trim()) as { version: string; outcomes: SparkHandshakeOutcome[] });
  }, 120_000);

  test("the child is Node and says which version ran the cases", () => {
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
    console.log(`tls-handshake: the Node child ran as ${version}`);
  });

  test("every case maps to its sentence", () => expectRun(outcomes, "node"));
});
