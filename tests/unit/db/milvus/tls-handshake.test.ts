/**
 * Real TLS handshakes and real endpoints through the Milvus adapter (vector-family spec E1, E6), under Bun and in a
 * Node child, the production runtime. Certificates are made at test time (tests/helpers/milvus-tls-material.ts);
 * `openssl s_server` stands in for a server that refuses a missing or an untrusted client certificate with the TLS
 * alert Milvus's Go stack sends, which a grpc-js server does not; a tunnel-shaped connection is the local forward with
 * TUNNEL_FAR_END set, which is all the factory's SSH tunnel leaves of itself. The expired client certificate never
 * reaches a handshake, because the preflight refuses it (connection-options.test.ts); the live check sends it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { allowlistedService } from "@/lib/db/providers/vector/milvus/grpc-client";
import { type HandshakeCase, type HandshakeOutcome, runHandshakeCases } from "../../../helpers/milvus-handshake-cases";
import { makeMilvusTlsMaterial, type MilvusTlsMaterial } from "../../../helpers/milvus-tls-material";

const OK = { code: 0, error_code: "Success", reason: "", retriable: false, detail: "", extra_info: {} };
const HELPER = join(import.meta.dir, "../../../helpers/milvus-handshake-cases.ts");

let material: MilvusTlsMaterial;
let work: string;
const servers: grpc.Server[] = [];
const sockets: net.Server[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const counts: Record<string, number> = {};

async function gRpcServer(serverCredentials: grpc.ServerCredentials): Promise<number> {
  const server = new grpc.Server();
  server.addService(allowlistedService(), {
    GetVersion: (_call: unknown, callback: grpc.sendUnaryData<object>) =>
      callback(null, { status: OK, version: "3.0.2" }),
  });
  servers.push(server);
  return new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", serverCredentials, (error, port) => (error ? reject(error) : resolve(port))),
  );
}

function tlsServer(certificate: string, clientCa?: string): Promise<number> {
  return gRpcServer(
    grpc.ServerCredentials.createSsl(
      clientCa === undefined ? null : Buffer.from(material.pem(`${clientCa}.crt`)),
      [
        {
          private_key: Buffer.from(material.pem(`${certificate}.key`)),
          cert_chain: Buffer.from(material.pem(`${certificate}.crt`)),
        },
      ],
      clientCa !== undefined,
    ),
  );
}

/** openssl s_server over TLS 1.3, requiring a client certificate the test CA signed; it answers no gRPC. */
async function alertingServer(): Promise<number> {
  const server = Bun.spawn(
    [
      "openssl",
      "s_server",
      "-accept",
      "127.0.0.1:0",
      "-cert",
      "localhost.crt",
      "-key",
      "localhost.key",
      "-CAfile",
      "ca.crt",
      "-Verify",
      "1",
      "-verify_return_error",
      "-tls1_3",
      "-alpn",
      "h2",
      "-www",
    ],
    {
      cwd: material.dir,
      env: { ...process.env, OPENSSL_CONF: join(material.dir, "openssl.cnf") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
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

async function socketListener(
  name: string,
  where: { readonly host: string } | { readonly path: string },
  onAccept: (socket: net.Socket) => void,
): Promise<number> {
  counts[name] = 0;
  const listener = net.createServer((socket) => {
    counts[name]++;
    socket.on("error", () => undefined);
    onAccept(socket);
  });
  sockets.push(listener);
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    if ("path" in where) listener.listen(where.path, () => resolve(0));
    else listener.listen(0, where.host, () => resolve((listener.address() as AddressInfo).port));
  });
}

const forwardTo = (port: number) => (socket: net.Socket) => {
  const upstream = net.connect(port, "127.0.0.1");
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  socket.pipe(upstream).pipe(socket);
};

async function closedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

let ports: Record<string, number>;

beforeAll(async () => {
  material = makeMilvusTlsMaterial();
  work = mkdtempSync(join(tmpdir(), "milvus-handshake-"));
  const upstream = await gRpcServer(grpc.ServerCredentials.createInsecure());
  const unixName = await closedPort();
  await socketListener("unix", { path: join(work, String(unixName)) }, forwardTo(upstream));
  ports = {
    localhost: await tlsServer("localhost"),
    ipOnly: await tlsServer("ip-only"),
    farIp: await tlsServer("far-ip"),
    farDns: await tlsServer("far-dns"),
    selfSigned: await tlsServer("self-signed"),
    mutual: await tlsServer("localhost", "ca"),
    alerting: await alertingServer(),
    plaintext: await gRpcServer(grpc.ServerCredentials.createInsecure()),
    loopback6: await socketListener("loopback6", { host: "::1" }, forwardTo(upstream)),
    unixName,
  };
}, 60_000);

afterAll(async () => {
  for (const server of servers) server.forceShutdown();
  for (const listener of sockets) listener.close();
  for (const child of processes) child.kill();
  await Promise.all(processes.map((child) => child.exited));
  material.remove();
  rmSync(work, { recursive: true, force: true });
});

const TIMEOUT = 3000;
const ssl = (mode: string, extra: Record<string, unknown> = {}) => ({ ssl: { mode, ...extra } });

function cases(): HandshakeCase[] {
  const ca = material.pem("ca.crt");
  const pair = (name: string) => ({ clientCert: material.pem(`${name}.crt`), clientKey: material.pem(`${name}.key`) });
  const provider = (
    name: string,
    connection: Record<string, unknown>,
    farEnd?: { host: string; port: number },
  ): HandshakeCase => ({
    name,
    via: "provider",
    connection: { id: name, name, type: "milvus", createdAt: 0, ...connection },
    ...(farEnd === undefined ? {} : { farEnd }),
    timeoutMs: TIMEOUT,
  });
  return [
    provider("verify-full by name", {
      host: "localhost",
      port: ports.localhost,
      ...ssl("verify-full", { caCert: ca }),
    }),
    provider("an IP identity, verified against the IP", {
      host: "127.0.0.1",
      port: ports.ipOnly,
      ...ssl("verify-full", { caCert: ca }),
    }),
    provider("a certificate for another IP", {
      host: "127.0.0.1",
      port: ports.farIp,
      ...ssl("verify-full", { caCert: ca }),
    }),
    provider(
      "a tunnel to an IP far end",
      { host: "127.0.0.1", port: ports.farIp, sshTunnel: { enabled: true }, ...ssl("verify-full", { caCert: ca }) },
      { host: "10.0.0.5", port: 19530 },
    ),
    provider(
      "a tunnel to a DNS far end",
      { host: "127.0.0.1", port: ports.farDns, sshTunnel: { enabled: true }, ...ssl("verify-full", { caCert: ca }) },
      { host: "milvus.test", port: 19530 },
    ),
    provider("no CA, the runtime's roots", { host: "localhost", port: ports.localhost, ...ssl("verify-full") }),
    provider("require accepts a certificate no CA vouches for", {
      host: "localhost",
      port: ports.selfSigned,
      ...ssl("require"),
    }),
    provider("verify-full refuses a self-signed certificate", {
      host: "localhost",
      port: ports.selfSigned,
      ...ssl("verify-full", { caCert: ca }),
    }),
    provider("TLS to a plaintext port", { host: "127.0.0.1", port: ports.plaintext, ...ssl("require") }),
    provider("mutual TLS with a clientAuth certificate", {
      host: "localhost",
      port: ports.mutual,
      ...ssl("verify-full", { caCert: ca, ...pair("client") }),
    }),
    provider("mutual TLS with no extended key usage", {
      host: "localhost",
      port: ports.mutual,
      ...ssl("verify-full", { caCert: ca, ...pair("client-noeku") }),
    }),
    provider("no client certificate where one is required", {
      host: "localhost",
      port: ports.alerting,
      ...ssl("verify-full", { caCert: ca }),
    }),
    provider("a client certificate from another CA", {
      host: "localhost",
      port: ports.alerting,
      ...ssl("verify-full", { caCert: ca, ...pair("client-other-ca") }),
    }),
    provider("a serverAuth-only client certificate", {
      host: "localhost",
      port: ports.mutual,
      ...ssl("verify-full", { caCert: ca, ...pair("client-serverauth") }),
    }),
    provider("a key that is not the certificate's", {
      host: "localhost",
      port: ports.mutual,
      ...ssl("verify-full", {
        caCert: ca,
        clientCert: material.pem("client.crt"),
        clientKey: material.pem("client-noeku.key"),
      }),
    }),
    provider("an IPv6 literal, bare", { host: "::1", port: ports.loopback6 }),
    provider("an IPv6 literal, bracketed", { host: "[::1]", port: ports.loopback6 }),
    provider("a host named unix", { host: "unix", port: ports.unixName }),
    provider("a scheme in Host", { host: "http://localhost", port: ports.plaintext }),
    {
      name: "control: grpc-js sends an IP as the TLS server name",
      via: "control",
      target: `127.0.0.1:${ports.ipOnly}`,
      ca,
      timeoutMs: TIMEOUT,
    },
    {
      name: "control: grpc-js reads unix: as a socket path",
      via: "control",
      target: `unix:${ports.unixName}`,
      timeoutMs: TIMEOUT,
    },
  ];
}

type Runtime = "bun" | "node";

/** What each case comes to: `nodeMajor` is the Node child's major, absent under Bun. */
function expected(
  name: string,
  runtime: Runtime,
  nodeMajor?: number,
): Partial<HandshakeOutcome> & { outcome: HandshakeOutcome["outcome"] } {
  const namesCause = runtime === "node";
  switch (name) {
    case "a certificate for another IP":
      return { outcome: "failed", category: "tls", tlsFailure: "name", errorClass: "ConnectionError" };
    case "no CA, the runtime's roots":
    case "verify-full refuses a self-signed certificate":
      return { outcome: "failed", category: "tls", tlsFailure: "chain", errorClass: "ConnectionError" };
    case "no client certificate where one is required":
      return namesCause
        ? {
            outcome: "failed",
            category: "tls",
            tlsFailure: "client-certificate-required",
            errorClass: "ConnectionError",
          }
        : { outcome: "failed", category: "not-connected", errorClass: "ConnectionError" };
    case "a client certificate from another CA":
      return namesCause
        ? {
            outcome: "failed",
            category: "tls",
            tlsFailure: "client-certificate-refused",
            errorClass: "ConnectionError",
          }
        : { outcome: "failed", category: "not-connected", errorClass: "ConnectionError" };
    case "a serverAuth-only client certificate":
      return {
        outcome: "refused",
        errorClass: "DatabaseConfigError",
        message:
          "The client certificate is not issued for client authentication: its extended key usage lacks clientAuth, so Milvus would refuse it. Paste a certificate issued for client use under SSL / TLS.",
      };
    case "a key that is not the certificate's":
      return {
        outcome: "refused",
        errorClass: "DatabaseConfigError",
        message:
          "The Client Private Key under SSL / TLS is not the key of the Client Certificate: paste the private key issued with that certificate there.",
      };
    case "a host named unix":
      return { outcome: "failed", category: "not-connected", errorClass: "ConnectionError" };
    case "a scheme in Host":
      return {
        outcome: "refused",
        errorClass: "DatabaseConfigError",
        message: "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.",
      };
    case "control: grpc-js sends an IP as the TLS server name":
      // Node 25 and later and Bun refuse an IP as the server name, which is why the provider overrides it (E6).
      return runtime === "bun" || (nodeMajor ?? 0) >= 25 ? { outcome: "failed" } : { outcome: "connected" };
    case "TLS to a plaintext port":
      return { outcome: "failed", errorClass: "ConnectionError" };
    case "control: grpc-js reads unix: as a socket path":
      // On Windows Bun connects there as elsewhere, and Node dials the Unix socket by that path too but is refused the
      // connect with EACCES (CI's windows-latest runner), as the etcd provider's control met it.
      return windowsNode(runtime) ? { outcome: "failed" } : { outcome: "connected" };
    default:
      return { outcome: "connected" };
  }
}

/** Node on Windows, where the E1 control's dial of the Unix socket is refused rather than connected. */
function windowsNode(runtime: Runtime): boolean {
  return process.platform === "win32" && runtime === "node";
}

function expectRun(outcomes: readonly HandshakeOutcome[], runtime: Runtime, nodeMajor?: number): void {
  const names = cases().map((item) => item.name);
  expect(outcomes.map((outcome) => outcome.name)).toEqual(names);
  for (const outcome of outcomes) {
    expect(outcome).toMatchObject({ name: outcome.name, ...expected(outcome.name, runtime, nodeMajor) });
  }
  const tlsToPlaintext = outcomes.find((outcome) => outcome.name === "TLS to a plaintext port") as {
    category?: string;
  };
  expect(["tls", "not-connected"]).toContain(tlsToPlaintext.category as string);
  const ipControl = outcomes.find(
    (outcome) => outcome.name === "control: grpc-js sends an IP as the TLS server name",
  ) as { raw?: string };
  if (runtime === "bun" || (nodeMajor ?? 0) >= 25)
    expect(ipControl.raw).toContain("Setting the TLS ServerName to an IP address is not permitted");
  // E1: the provider's `unix` host dialled no socket; only the control reached the listener named after the port.
  // Node on Windows is refused the control's connect, so its run reaches the listener not at all, and says why.
  if (windowsNode(runtime)) {
    expect(counts.unix).toBe(0);
    const unixControl = outcomes.find(
      (outcome) => outcome.name === "control: grpc-js reads unix: as a socket path",
    ) as {
      raw?: string;
    };
    expect(unixControl.raw).toContain("connect EACCES");
  } else expect(counts.unix).toBe(1);
}

describe("under Bun (E1, E6)", () => {
  let outcomes: HandshakeOutcome[] = [];
  beforeAll(async () => {
    counts.unix = 0;
    const cwd = process.cwd();
    // grpc-js looks for `unix:<port>` in the working directory.
    process.chdir(work);
    try {
      outcomes = await runHandshakeCases(cases());
    } finally {
      process.chdir(cwd);
    }
  }, 90_000);

  test("every case comes to what E1 and E6 say, and the unix host dials no socket", () => expectRun(outcomes, "bun"));
});

describe("in a Node child, the production runtime (E6)", () => {
  let outcomes: HandshakeOutcome[] = [];
  let version = "";
  beforeAll(async () => {
    counts.unix = 0;
    const node = Bun.which("node");
    if (node === null)
      throw new Error("No node on PATH: this block runs every case under Node; install Node 24 or later");
    writeFileSync(
      join(work, "child.ts"),
      [
        'import { readFileSync } from "node:fs";',
        `import { runHandshakeCases } from ${JSON.stringify(HELPER)};`,
        'const outcomes = await runHandshakeCases(JSON.parse(readFileSync(process.argv[2], "utf8")));',
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
    ({ version, outcomes } = JSON.parse(stdout.trim()) as { version: string; outcomes: HandshakeOutcome[] });
  }, 150_000);

  test("the child is Node and says which version ran the cases", () => {
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
    console.log(`tls-handshake: the Node child ran as ${version}`);
  });

  test("every case comes to what E1 and E6 say", () =>
    expectRun(outcomes, "node", Number(version.slice(1).split(".")[0])));
});
