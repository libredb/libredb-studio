/**
 * Real TLS handshakes and real transport failures through the adapter (spec E1, E5, 5.6, gate 1), under both
 * runtimes.
 *
 * Every case is one connection as the dialog or a seed writes it, taken through `buildEtcdConnectionOptions`,
 * `createGrpcEtcdClient` over `grpcWireTransport`, one `Status` call, and `toProviderError`, against listeners this
 * file starts: TLS gRPC servers whose certificates are made here with openssl, into a temporary directory, and never
 * committed; `openssl s_server`, which refuses a missing or an untrusted client certificate with the TLS alert etcd's
 * Go stack sends; TCP listeners on `::1` that count what they accept; a Unix socket named after a port; and listeners
 * that stay silent, reset, or are closed. A tunnel-shaped connection is the local forward with TUNNEL_FAR_END set,
 * which is all the factory's SSH tunnel leaves of itself (src/lib/db/factory.ts), so no SSH server is needed.
 *
 * Each failure is pinned three ways: the code and the text the runtime gave, which a transport wrapped around
 * `grpcWireTransport` records from the error its channel rejected with; the adapter's classification of that error;
 * and the sentence of spec 5.6 that leads the provider's message, with the runtime's words after it (spec E16).
 *
 * `runCases` runs the cases. It runs here, under Bun, and again in a Node child: the `node` on PATH runs a bundle
 * that `Bun.build({ target: "node" })` makes of the adapter's own modules around the text of that one function, so
 * both runtimes run the same code against the same listeners. The child reports its `process.version`, and the
 * expectations follow the branch that version takes: Node 25 and later, and Bun, refuse an IP address as the TLS
 * server name, which a control connection built here with @grpc/grpc-js directly, without the adapter's override,
 * shows, while the adapter's own connections pass on every runtime (spec E5, reconciliation D0-3).
 *
 * The same child is KE16's fallback for a real-transport test, should Bun's HTTP/2 stall (spec section 11).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import type { EtcdErrorCategory, EtcdTlsFailure } from "@/lib/db/providers/keyvalue/etcd/client";
import { buildEtcdConnectionOptions, etcdErrorConnection } from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { toProviderError } from "@/lib/db/providers/keyvalue/etcd/errors";
import {
  createGrpcEtcdClient,
  ETCD_LOADER_OPTIONS,
  type EtcdWireTransport,
  grpcWireTransport,
} from "@/lib/db/providers/keyvalue/etcd/grpc-client";
import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";
import { TUNNEL_FAR_END } from "@/lib/types";

// -- the cases, as both runtimes run them ------------------------------------------------------------------------

/** One connection attempt, in the JSON the Node child reads. */
type HandshakeCase =
  | {
      readonly name: string;
      readonly via: "adapter";
      /** The connection as the dialog or a seed writes it. */
      readonly connection: Record<string, unknown>;
      /** The tunnel's far end, set on the connection under TUNNEL_FAR_END: a symbol key does not survive JSON. */
      readonly farEnd?: { readonly host: string; readonly port: number };
      readonly timeoutMs: number;
    }
  | {
      readonly name: string;
      /** A channel built with @grpc/grpc-js directly, with no override and no `dns:` scheme of the adapter's. */
      readonly via: "control";
      readonly target: string;
      readonly tls: boolean;
      readonly timeoutMs: number;
    };

/** What the runtime rejected a call with, as grpc-js hands it on: the status code and its text. */
interface RawFailure {
  readonly code?: number;
  readonly details: string;
}

/** What one attempt came to. */
type HandshakeOutcome =
  | { readonly name: string; readonly outcome: "connected"; readonly target: string }
  | { readonly name: string; readonly outcome: "refused"; readonly errorClass: string; readonly message: string }
  | {
      readonly name: string;
      readonly outcome: "failed";
      readonly target: string;
      /** The runtime's own code and text; absent when the call failed before the channel was asked for anything. */
      readonly raw?: RawFailure;
      /** The adapter's EtcdError, and the provider's error `toProviderError` made of it; absent for a control. */
      readonly category?: string;
      readonly tlsFailure?: string;
      readonly grpcCode?: number;
      readonly errorClass?: string;
      readonly message?: string;
    };

/** What `runCases` needs from the modules around it; the Node child's bundle passes its own copies. */
interface RunnerDeps {
  readonly grpc: typeof grpc;
  readonly createGrpcEtcdClient: typeof createGrpcEtcdClient;
  readonly grpcWireTransport: typeof grpcWireTransport;
  readonly buildEtcdConnectionOptions: typeof buildEtcdConnectionOptions;
  readonly etcdErrorConnection: typeof etcdErrorConnection;
  readonly toProviderError: typeof toProviderError;
  readonly TUNNEL_FAR_END: typeof TUNNEL_FAR_END;
}

/**
 * Runs each case in turn and reports what it came to. SELF-CONTAINED ON PURPOSE: the Node child runs this
 * function's own text (`runCases.toString()`), so it names nothing but its parameters and the runtime's globals. A
 * name of this module used in here would be a ReferenceError in the child, which fails the Node block by name.
 */
async function runCases(deps: RunnerDeps, cases: readonly HandshakeCase[]): Promise<HandshakeOutcome[]> {
  const outcomes: HandshakeOutcome[] = [];
  for (const item of cases) {
    if (item.via === "control") {
      // The control: @grpc/grpc-js as it comes, so the TLS server name is the dialled address (spec E5) and a
      // target without a scheme is read by grpc-js's own resolvers (spec E1).
      const channelCredentials = item.tls
        ? deps.grpc.credentials.createSsl(null, null, null, { rejectUnauthorized: false })
        : deps.grpc.credentials.createInsecure();
      const control = new deps.grpc.Client(item.target, channelCredentials, {
        "grpc.service_config_disable_resolution": 1,
      });
      const bytes = (value: Buffer) => value;
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, so each listener's count is its case's alone.
      const failure = await new Promise<RawFailure | null>((resolve) => {
        control.makeUnaryRequest(
          "/etcdserverpb.Maintenance/Status",
          bytes,
          bytes,
          Buffer.alloc(0),
          new deps.grpc.Metadata(),
          { deadline: Date.now() + item.timeoutMs },
          (error) => resolve(error === null ? null : { code: error.code, details: error.details }),
        );
      });
      control.close();
      outcomes.push(
        failure === null
          ? { name: item.name, outcome: "connected", target: item.target }
          : { name: item.name, outcome: "failed", target: item.target, raw: failure },
      );
      continue;
    }
    let options: ReturnType<RunnerDeps["buildEtcdConnectionOptions"]>;
    try {
      const connection =
        item.farEnd === undefined ? item.connection : { ...item.connection, [deps.TUNNEL_FAR_END]: item.farEnd };
      options = deps.buildEtcdConnectionOptions(connection as never, {
        executionReadOnly: false,
        queryTimeout: item.timeoutMs,
      });
    } catch (error) {
      const refusal = error as Error;
      outcomes.push({ name: item.name, outcome: "refused", errorClass: refusal.name, message: refusal.message });
      continue;
    }
    // The error grpcWireTransport's channel rejected with, before the adapter reads it: the runtime's code and text.
    const recorded: { failure?: RawFailure } = {};
    const recording: EtcdWireTransport = (channelOptions) => {
      const channel = deps.grpcWireTransport(channelOptions);
      return {
        unary: (rpc, request, call) =>
          channel.unary(rpc, request, call).catch((error: unknown) => {
            const { code, details, message } = error as { code?: number; details?: string; message?: string };
            recorded.failure ??= { code, details: details ?? String(message) };
            throw error;
          }),
        stream: (rpc, call) => channel.stream(rpc, call),
        close: () => channel.close(),
      };
    };
    let client: Awaited<ReturnType<RunnerDeps["createGrpcEtcdClient"]>> | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, so each listener's count is its case's alone.
      client = await deps.createGrpcEtcdClient(options, {}, recording);
      // oxlint-disable-next-line no-await-in-loop -- the case's one call, on the channel it just opened.
      await client.status({ signal: new AbortController().signal });
      outcomes.push({ name: item.name, outcome: "connected", target: options.target });
    } catch (error) {
      const failure = error as { readonly category?: string; readonly tlsFailure?: string; readonly grpcCode?: number };
      const mapped = deps.toProviderError(error, {
        command: "endpoint status",
        write: false,
        connection: deps.etcdErrorConnection(options),
      });
      outcomes.push({
        name: item.name,
        outcome: "failed",
        target: options.target,
        ...(recorded.failure === undefined ? {} : { raw: recorded.failure }),
        category: failure.category,
        tlsFailure: failure.tlsFailure,
        grpcCode: failure.grpcCode,
        errorClass: mapped.name,
        message: mapped.message,
      });
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- the channel closes before the next case dials.
      await client?.close();
    }
  }
  return outcomes;
}

// -- the listeners ------------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "etcd-tls-handshake-"));
const at = (file: string) => join(dir, file);
const read = (file: string) => readFileSync(at(file), "utf8");
const ETCD_SOURCES = join(import.meta.dir, "../../../../src/lib/db/providers/keyvalue/etcd");
const OPENSSL_ENV = { ...process.env, OPENSSL_CONF: at("openssl.cnf") };

function openssl(...args: string[]): void {
  const run = Bun.spawnSync(["openssl", ...args], { cwd: dir, env: OPENSSL_ENV, stdout: "ignore", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${run.stderr.toString()}`);
}

let serial = 1000;

/** A P-256 key and a certificate that `issuer` signs, or a self-signed one when it is its own issuer. */
function certificate(name: string, subject: string, extensions: readonly string[], issuer = name): void {
  writeFileSync(at(`${name}.ext`), `${extensions.join("\n")}\n`);
  openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`);
  openssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${subject}`, "-out", `${name}.csr`);
  const signer =
    issuer === name
      ? ["-key", `${name}.key`]
      : ["-CA", `${issuer}.crt`, "-CAkey", `${issuer}.key`, "-set_serial", String(serial++)];
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    ...signer,
    "-days",
    "1",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  );
}

const CA_EXTENSIONS = ["basicConstraints = critical, CA:TRUE", "keyUsage = critical, keyCertSign, cRLSign"];
const serverExtensions = (names: string) => [
  "basicConstraints = CA:FALSE",
  `subjectAltName = ${names}`,
  "extendedKeyUsage = serverAuth",
];
const CLIENT_EXTENSIONS = ["basicConstraints = CA:FALSE", "extendedKeyUsage = clientAuth"];

const MAINTENANCE = fromJSON(ETCD_DESCRIPTOR, ETCD_LOADER_OPTIONS)[
  "etcdserverpb.Maintenance"
] as unknown as grpc.ServiceDefinition;
const STATUS_ANSWER = {
  header: { cluster_id: "1", member_id: "1", revision: "1", raft_term: "1" },
  version: "3.7.2",
  leader: "1",
};

const servers: grpc.Server[] = [];
const sockets: net.Server[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
/** How many Status calls each gRPC server answered, and how many connections each socket listener accepted. */
const counts: Record<string, number> = {};

async function gRpcServer(name: string, serverCredentials: grpc.ServerCredentials): Promise<number> {
  counts[name] = 0;
  const server = new grpc.Server();
  server.addService(MAINTENANCE, {
    Status: (_call: unknown, callback: grpc.sendUnaryData<object>) => {
      counts[name]++;
      callback(null, STATUS_ANSWER);
    },
  });
  servers.push(server);
  return new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", serverCredentials, (error, port) => (error ? reject(error) : resolve(port))),
  );
}

/** A TLS gRPC server with the named certificate; `clientCa` makes it require a client certificate that CA signed. */
function tlsServer(name: string, certificateName: string, clientCa?: string): Promise<number> {
  return gRpcServer(
    name,
    grpc.ServerCredentials.createSsl(
      clientCa === undefined ? null : Buffer.from(read(`${clientCa}.crt`)),
      [
        {
          private_key: Buffer.from(read(`${certificateName}.key`)),
          cert_chain: Buffer.from(read(`${certificateName}.crt`)),
        },
      ],
      clientCa !== undefined,
    ),
  );
}

/**
 * `openssl s_server` over TLS 1.3 with the named certificate, requiring a client certificate that `clientCa` signed.
 * It refuses a missing client certificate with the alert "certificate required" and one from another CA with
 * "unknown ca", as etcd's Go stack does (spec E5, R07), where a grpc-js server, under Node and Bun alike, closes the
 * socket without an alert. It answers no gRPC, so only the refusals are driven against it. It binds a port of its
 * own choosing and prints it on its ACCEPT line.
 */
async function alertingServer(certificateName: string, clientCa: string): Promise<number> {
  const server = Bun.spawn(
    [
      "openssl",
      "s_server",
      "-accept",
      "127.0.0.1:0",
      "-cert",
      `${certificateName}.crt`,
      "-key",
      `${certificateName}.key`,
      "-CAfile",
      `${clientCa}.crt`,
      "-Verify",
      "1",
      "-verify_return_error",
      "-tls1_3",
      "-alpn",
      "h2",
      "-www",
    ],
    { cwd: dir, env: OPENSSL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  processes.push(server);
  const reader = server.stdout.getReader();
  // s_server prints "ACCEPT <address>:<port>" once it listens (measured with OpenSSL 3.6.3).
  const listening = /^ACCEPT \S+:(\d+)$/m;
  let printed = "";
  let ended = false;
  while (!ended && !listening.test(printed)) {
    // oxlint-disable-next-line no-await-in-loop -- s_server prints ACCEPT once it listens, and nothing dials it before.
    const { done, value } = await reader.read();
    ended = done;
    if (value !== undefined) printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = listening.exec(printed)?.[1];
  if (port === undefined) {
    throw new Error(
      `openssl s_server did not print the port it listens on (stdout: ${printed}; stderr: ${await new Response(server.stderr).text()})`,
    );
  }
  return Number(port);
}

/** A socket listener that counts what it accepts; `onAccept` decides what an accepted connection meets. */
function socketListener(
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
    const listening = () => resolve("path" in where ? 0 : (listener.address() as AddressInfo).port);
    if ("path" in where) listener.listen(where.path, listening);
    else listener.listen(0, where.host, listening);
  });
}

/** Carries an accepted connection to the plaintext gRPC server, so a dial through the listener is answered. */
const forwardTo = (port: number) => (socket: net.Socket) => {
  const upstream = net.connect(port, "127.0.0.1");
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  socket.pipe(upstream).pipe(socket);
};

/** A port nothing listens on: one a listener held a moment ago. */
async function closedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

/** Every listener's port, by the name the cases use. */
interface Listeners {
  /** TLS gRPC servers, by certificate. */
  readonly selfSigned: number;
  readonly localhost: number;
  readonly otherHost: number;
  readonly ipOnly: number;
  readonly farIp: number;
  readonly farDns: number;
  readonly localForward: number;
  readonly mutual: number;
  /** openssl s_server requiring a client certificate the test CA signed, with the certificate `localhost` serves. */
  readonly alerting: number;
  /** A plaintext gRPC server, which the TLS and the Unix socket listeners forward to, and plaintext modes dial. */
  readonly upstream: number;
  /** A plaintext gRPC server of its own, for the TLS connection that must not fall back to plaintext. */
  readonly plaintext: number;
  /** TCP on `::1`, forwarding to a plaintext gRPC server and counting accepts (spec E1). */
  readonly loopback6: number;
  /** A TCP port no case dials, and the name of the Unix socket in the working directory (spec E1). */
  readonly unixName: number;
  readonly silent: number;
  readonly resetting: number;
  readonly closed: number;
}

let listeners: Listeners;

beforeAll(async () => {
  if (Bun.which("openssl") === null) {
    throw new Error(
      "No openssl on PATH: this file makes its certificates at test time, and none are committed; install OpenSSL",
    );
  }
  writeFileSync(at("openssl.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n");
  certificate("ca", "libredb-test-ca", CA_EXTENSIONS);
  certificate("other-ca", "libredb-other-ca", CA_EXTENSIONS);
  certificate("self-signed", "localhost", serverExtensions("DNS:localhost"));
  certificate("localhost", "localhost", serverExtensions("DNS:localhost"), "ca");
  certificate("other-host", "other.test", serverExtensions("DNS:other.test"), "ca");
  certificate("ip-only", "etcd-ip", serverExtensions("IP:127.0.0.1"), "ca");
  certificate("far-ip", "etcd-far-ip", serverExtensions("IP:10.0.0.5"), "ca");
  certificate("far-dns", "etcd.test", serverExtensions("DNS:etcd.test"), "ca");
  certificate("local-forward", "localhost", serverExtensions("DNS:localhost, IP:127.0.0.1"), "ca");
  certificate("client", "reader", CLIENT_EXTENSIONS, "ca");
  certificate("other-client", "reader", CLIENT_EXTENSIONS, "other-ca");

  const upstream = await gRpcServer("upstream", grpc.ServerCredentials.createInsecure());
  const unixName = await closedPort();
  await socketListener("unix", { path: at(String(unixName)) }, forwardTo(upstream));
  listeners = {
    selfSigned: await tlsServer("selfSigned", "self-signed"),
    localhost: await tlsServer("localhost", "localhost"),
    otherHost: await tlsServer("otherHost", "other-host"),
    ipOnly: await tlsServer("ipOnly", "ip-only"),
    farIp: await tlsServer("farIp", "far-ip"),
    farDns: await tlsServer("farDns", "far-dns"),
    localForward: await tlsServer("localForward", "local-forward"),
    mutual: await tlsServer("mutual", "localhost", "ca"),
    alerting: await alertingServer("localhost", "ca"),
    upstream,
    plaintext: await gRpcServer("plaintext", grpc.ServerCredentials.createInsecure()),
    loopback6: await socketListener("loopback6", { host: "::1" }, forwardTo(upstream)),
    unixName,
    silent: await socketListener("silent", { host: "127.0.0.1" }, () => undefined),
    resetting: await socketListener("resetting", { host: "127.0.0.1" }, (socket) => socket.resetAndDestroy()),
    closed: await closedPort(),
  };
  // The three hooks' timeouts add up to less than the runner's 300 s per file, so a hook that times out still reaches
  // afterAll, which stops s_server and removes the temporary directory.
}, 30_000);

afterAll(() => {
  for (const server of servers) server.forceShutdown();
  for (const listener of sockets) listener.close();
  for (const child of processes) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

// -- the cases and what each runtime is expected to make of them --------------------------------------------------

type Runtime = "bun" | "node";

interface Expected {
  readonly outcome: HandshakeOutcome["outcome"];
  /** A refusal's whole message. */
  readonly message?: string;
  readonly target?: string;
  readonly category?: EtcdErrorCategory;
  readonly tlsFailure?: EtcdTlsFailure;
  /** The gRPC code the runtime gave, which the adapter's EtcdError keeps (spec E5). */
  readonly grpcCode?: number;
  /** The runtime's or grpc-js's own text, as its channel rejected the call. */
  readonly text?: RegExp;
  /** The sentence of spec 5.6 that leads the message; the runtime's words follow it in parentheses. */
  readonly sentence?: string;
}

/** `nodeRefusesIpServerName` is true from Node 25 on, the branch production's Node 26 takes (spec E5). */
type Expectation = (runtime: Runtime, nodeRefusesIpServerName: boolean) => Expected;

interface CaseDefinition {
  readonly name: string;
  /** "undialled" cases run first, and nothing may be accepted while they do (spec E1). */
  readonly phase: "undialled" | "dialled";
  readonly make: (ports: Listeners) => HandshakeCase;
  readonly expected: (ports: Listeners) => Expectation;
}

const HOST_TAKES_NAME_ONLY = "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.";
const INVALID_HOST = "Invalid host: expected a hostname, an IPv4 address or an IPv6 address";
const INVALID_PORT = "Invalid port: expected an integer from 1 to 65535";

// The sentences of spec 5.6, as errors.ts words them.
const CHAIN = "The server's certificate is not signed by the CA under SSL / TLS: paste the etcd CA.";
const doesNotName = (identity: string) =>
  `The certificate does not name ${identity}: connect by a name or address the certificate carries.`;
const NOT_TLS = "This port did not answer TLS: set SSL mode to disable, or use etcd's TLS port.";
const CLIENT_CERTIFICATE_REQUIRED =
  "This etcd requires a client certificate (--client-cert-auth), and none is configured: add the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).";
const CLIENT_CERTIFICATE_REFUSED =
  "etcd refused the client certificate under SSL / TLS: it must be issued by the CA etcd trusts for clients (--trusted-ca-file).";
const noPlaintextAnswer = (endpoint: string) =>
  `No etcd answered a plaintext connection at ${endpoint}. If this etcd serves TLS (kubeadm and k3s always do), choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel.`;
/** A TLS connection that failed with no named cause: Node's sentence, and Bun's two, by whether a client certificate is configured. */
const noTlsAnswer = (runtime: Runtime, endpoint: string, clientCertificate: boolean) => {
  if (runtime === "node") {
    return `No etcd answered a TLS connection at ${endpoint}: check the host, the port, the SSL mode and the tunnel.`;
  }
  const unreported = `No TLS connection to etcd at ${endpoint} was established, and this runtime does not report why`;
  return clientCertificate
    ? `${unreported}: check the host, the port, the SSL mode, the certificates and the tunnel.`
    : `${unreported}. No client certificate is configured: if this etcd requires one (--client-cert-auth), add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.`;
};

const BASE = { id: "e", name: "e", type: "etcd" };
const TIMEOUT_MS = 5000;

function direct(host: string, port: number, ssl?: Record<string, unknown> | null): Record<string, unknown> {
  return { ...BASE, host, port, ...(ssl === undefined ? {} : { ssl }) };
}

/** A connection an SSH tunnel carries, as the factory hands it on: the local forward, and the tunnel still marked on. */
function forwarded(port: number, ssl: Record<string, unknown>): Record<string, unknown> {
  return {
    ...direct("127.0.0.1", port, ssl),
    sshTunnel: { enabled: true, host: "bastion.test", port: 22, username: "u", authMethod: "password" },
  };
}

const connected = (): Expectation => () => ({ outcome: "connected" });
const refused =
  (message: string): Expectation =>
  () => ({ outcome: "refused", message });
/** A failed handshake both runtimes name alike. */
const tlsFailure =
  (failure: EtcdTlsFailure, text: RegExp, sentence: string): Expectation =>
  () => ({ outcome: "failed", category: "tls", tlsFailure: failure, grpcCode: 14, text, sentence });

function adapterCase(
  name: string,
  connection: (ports: Listeners) => Record<string, unknown>,
  expected: (ports: Listeners) => Expectation,
  extra: { readonly farEnd?: { readonly host: string; readonly port: number }; readonly timeoutMs?: number } = {},
): CaseDefinition {
  return {
    name,
    phase: "dialled",
    make: (ports) => ({
      name,
      via: "adapter",
      connection: connection(ports),
      ...(extra.farEnd === undefined ? {} : { farEnd: extra.farEnd }),
      timeoutMs: extra.timeoutMs ?? TIMEOUT_MS,
    }),
    expected,
  };
}

/** A host or a port spec E1 refuses, aimed at the `::1` listener's port, so a dial would be an accept there. */
function refusedEndpoint(label: string, endpoint: { host?: string; port?: unknown }, message: string): CaseDefinition {
  const name = `E1: ${label} is refused before any dial`;
  return {
    name,
    phase: "undialled",
    make: (ports) => ({
      name,
      via: "adapter",
      connection: { ...direct(endpoint.host ?? "::1", ports.loopback6), ...("port" in endpoint ? endpoint : {}) },
      timeoutMs: TIMEOUT_MS,
    }),
    expected: () => refused(message),
  };
}

const FAR_DNS = { host: "etcd.test", port: 2379 };
const FAR_IP = { host: "10.0.0.5", port: 2379 };
const RESOLVER_NAMES = ["unix", "dns", "ipv4", "ipv6"] as const;

const VERIFY_FULL_SELF_SIGNED = "verify-full with no CA rejects a self-signed server";
const VERIFY_SYSTEM_SELF_SIGNED = "verify-system rejects a self-signed server";
const TLS_TO_PLAINTEXT = "TLS to a plaintext port fails as not TLS, and nothing is sent in plaintext";

const CASES: readonly CaseDefinition[] = [
  // -- spec E1: nothing is dialled for an endpoint that is refused, or for a host that names a grpc-js resolver
  refusedEndpoint("host etcd:2379", { host: "etcd:2379" }, HOST_TAKES_NAME_ONLY),
  refusedEndpoint("host [::1]:2379", { host: "[::1]:2379" }, HOST_TAKES_NAME_ONLY),
  refusedEndpoint("host https://[::1]", { host: "https://[::1]" }, HOST_TAKES_NAME_ONLY),
  refusedEndpoint("the zoned host ::1%lo", { host: "::1%lo" }, INVALID_HOST),
  refusedEndpoint("the zoned host fe80::1%eth0", { host: "fe80::1%eth0" }, INVALID_HOST),
  refusedEndpoint("a host with a colon and a slash", { host: "::1/x" }, HOST_TAKES_NAME_ONLY),
  refusedEndpoint("a host with a slash", { host: "localhost/x" }, INVALID_HOST),
  refusedEndpoint("a host with an at sign", { host: "u@localhost" }, INVALID_HOST),
  refusedEndpoint("a host with a percent sign", { host: "local%68ost" }, INVALID_HOST),
  refusedEndpoint("a host with a space", { host: "local host" }, INVALID_HOST),
  refusedEndpoint("port 0", { port: 0 }, INVALID_PORT),
  refusedEndpoint("port 65536", { port: 65_536 }, INVALID_PORT),
  refusedEndpoint("port -1", { port: -1 }, INVALID_PORT),
  ...RESOLVER_NAMES.map(
    (host): CaseDefinition => ({
      name: `E1: host ${host} is a DNS name, never the ${host}: resolver of grpc-js`,
      phase: "undialled",
      make: (ports) => ({
        name: `E1: host ${host} is a DNS name, never the ${host}: resolver of grpc-js`,
        via: "adapter",
        connection: direct(host, ports.unixName),
        timeoutMs: 3000,
      }),
      expected: (ports) => () => ({
        outcome: "failed",
        target: `dns:${host}:${ports.unixName}`,
        category: "not-connected",
        grpcCode: 14,
        text: new RegExp(`^Name resolution failed for target dns:${host}:${ports.unixName}$`),
        sentence: noPlaintextAnswer(`${host}:${ports.unixName}`),
      }),
    }),
  ),
  // -- spec E1: the controls, which show that each listener above would have seen a dial
  adapterCase(
    "E1: host ::1 dials dns:[::1]:<port>",
    (ports) => direct("::1", ports.loopback6),
    (ports) => () => ({ outcome: "connected", target: `dns:[::1]:${ports.loopback6}` }),
  ),
  adapterCase(
    "E1: host [::1] dials dns:[::1]:<port>",
    (ports) => direct("[::1]", ports.loopback6),
    (ports) => () => ({ outcome: "connected", target: `dns:[::1]:${ports.loopback6}` }),
  ),
  {
    name: "E1 control: grpc-js alone reads unix:<port> as the Unix socket named after the port",
    phase: "dialled",
    make: (ports) => ({
      name: "E1 control: grpc-js alone reads unix:<port> as the Unix socket named after the port",
      via: "control",
      target: `unix:${ports.unixName}`,
      tls: false,
      timeoutMs: TIMEOUT_MS,
    }),
    expected: () => connected(),
  },
  // -- spec E5: the chain
  adapterCase(
    VERIFY_FULL_SELF_SIGNED,
    (ports) => direct("localhost", ports.selfSigned, { mode: "verify-full" }),
    () => tlsFailure("chain", /self[- ]signed certificate/, CHAIN),
  ),
  adapterCase(
    VERIFY_SYSTEM_SELF_SIGNED,
    (ports) => direct("localhost", ports.selfSigned, { mode: "verify-system" }),
    () => tlsFailure("chain", /self[- ]signed certificate/, CHAIN),
  ),
  adapterCase(
    "require accepts a self-signed server",
    (ports) => direct("localhost", ports.selfSigned, { mode: "require" }),
    () => connected(),
  ),
  adapterCase(
    "verify-full with the right CA connects",
    (ports) => direct("localhost", ports.localhost, { mode: "verify-full", caCert: read("ca.crt") }),
    () => connected(),
  ),
  adapterCase(
    "verify-ca with the right CA connects",
    (ports) => direct("localhost", ports.localhost, { mode: "verify-ca", caCert: read("ca.crt") }),
    () => connected(),
  ),
  ...(["verify-ca", "verify-full"] as const).map((mode) =>
    adapterCase(
      `${mode} with a wrong CA rejects`,
      (ports) => direct("localhost", ports.localhost, { mode, caCert: read("other-ca.crt") }),
      () => tlsFailure("chain", /unable to verify the first certificate/, CHAIN),
    ),
  ),
  // -- spec E5: the name
  ...(["verify-ca", "verify-full"] as const).map((mode) =>
    adapterCase(
      `${mode} refuses a certificate from the right CA that names another host`,
      (ports) => direct("localhost", ports.otherHost, { mode, caCert: read("ca.crt") }),
      () =>
        tlsFailure(
          "name",
          /Hostname\/IP does not match certificate's altnames: Host: localhost\. is not in the cert's altnames: DNS:other\.test/,
          doesNotName("localhost"),
        ),
    ),
  ),
  adapterCase(
    "an IP-only certificate verifies for its IP",
    (ports) => direct("127.0.0.1", ports.ipOnly, { mode: "verify-full", caCert: read("ca.crt") }),
    () => connected(),
  ),
  adapterCase(
    "an IP-only certificate is refused for another IP",
    (ports) => direct("127.0.0.1", ports.farIp, { mode: "verify-full", caCert: read("ca.crt") }),
    () =>
      tlsFailure(
        "name",
        /Hostname\/IP does not match certificate's altnames: IP: 127\.0\.0\.1 is not in the cert's list: 10\.0\.0\.5/,
        doesNotName("127.0.0.1"),
      ),
  ),
  adapterCase(
    "require connects to an IP host on every runtime, where the control is refused from Node 25 on",
    (ports) => direct("127.0.0.1", ports.selfSigned, { mode: "require" }),
    () => connected(),
  ),
  // -- spec E5's table: no mode is silently verified or silently not
  adapterCase(
    "disable is a plaintext channel",
    (ports) => direct("127.0.0.1", ports.upstream, { mode: "disable" }),
    () => connected(),
  ),
  adapterCase(
    "a null ssl panel is a plaintext channel",
    (ports) => direct("127.0.0.1", ports.upstream, null),
    () => connected(),
  ),
  adapterCase(
    "a panel with no mode verifies the name",
    (ports) => direct("localhost", ports.otherHost, { caCert: read("ca.crt") }),
    () =>
      tlsFailure(
        "name",
        /Hostname\/IP does not match certificate's altnames: Host: localhost\. is not in the cert's altnames: DNS:other\.test/,
        doesNotName("localhost"),
      ),
  ),
  adapterCase(
    "rejectUnauthorized true makes require verify the name",
    (ports) =>
      direct("localhost", ports.otherHost, { mode: "require", rejectUnauthorized: true, caCert: read("ca.crt") }),
    () =>
      tlsFailure(
        "name",
        /Hostname\/IP does not match certificate's altnames: Host: localhost\. is not in the cert's altnames: DNS:other\.test/,
        doesNotName("localhost"),
      ),
  ),
  adapterCase(
    "rejectUnauthorized false makes verify-full check nothing",
    (ports) => direct("localhost", ports.selfSigned, { mode: "verify-full", rejectUnauthorized: false }),
    () => connected(),
  ),
  // -- spec E5: client certificates
  adapterCase(
    "a server that requires a client certificate accepts the configured one",
    (ports) =>
      direct("localhost", ports.mutual, {
        mode: "verify-full",
        caCert: read("ca.crt"),
        clientCert: read("client.crt"),
        clientKey: read("client.key"),
      }),
    () => connected(),
  ),
  adapterCase(
    "a server that requires a client certificate refuses a connection without one",
    (ports) => direct("localhost", ports.alerting, { mode: "verify-full", caCert: read("ca.crt") }),
    (ports) => (runtime) =>
      runtime === "node"
        ? {
            outcome: "failed",
            category: "tls",
            tlsFailure: "client-certificate-required",
            grpcCode: 14,
            text: /tlsv13 alert certificate required/,
            sentence: CLIENT_CERTIFICATE_REQUIRED,
          }
        : {
            outcome: "failed",
            category: "not-connected",
            grpcCode: 14,
            text: /Last error: Failed to connect/,
            sentence: noTlsAnswer("bun", `localhost:${ports.alerting}`, false),
          },
  ),
  adapterCase(
    "a server that requires a client certificate refuses one from another CA",
    (ports) =>
      direct("localhost", ports.alerting, {
        mode: "verify-full",
        caCert: read("ca.crt"),
        clientCert: read("other-client.crt"),
        clientKey: read("other-client.key"),
      }),
    (ports) => (runtime) =>
      runtime === "node"
        ? {
            outcome: "failed",
            category: "tls",
            tlsFailure: "client-certificate-refused",
            grpcCode: 14,
            text: /tlsv1 alert unknown ca/,
            sentence: CLIENT_CERTIFICATE_REFUSED,
          }
        : {
            outcome: "failed",
            category: "not-connected",
            grpcCode: 14,
            text: /Last error: Failed to connect/,
            sentence: noTlsAnswer("bun", `localhost:${ports.alerting}`, true),
          },
  ),
  // -- spec E5: through a tunnel-shaped connection, the far end decides the name and the dial target never does
  adapterCase(
    "tunnel, DNS far end: verify-full connects to a certificate whose only name is the far end",
    (ports) => forwarded(ports.farDns, { mode: "verify-full", caCert: read("ca.crt") }),
    () => connected(),
    { farEnd: FAR_DNS },
  ),
  adapterCase(
    "tunnel, DNS far end: verify-full refuses a certificate issued for 127.0.0.1 and localhost",
    (ports) => forwarded(ports.localForward, { mode: "verify-full", caCert: read("ca.crt") }),
    () =>
      tlsFailure(
        "name",
        /Host: etcd\.test\. is not in the cert's altnames: DNS:localhost, IP Address:127\.0\.0\.1/,
        doesNotName("etcd.test"),
      ),
    { farEnd: FAR_DNS },
  ),
  adapterCase(
    "tunnel, IP far end: verify-full connects to a certificate whose only name is the far end's IP",
    (ports) => forwarded(ports.farIp, { mode: "verify-full", caCert: read("ca.crt") }),
    () => connected(),
    { farEnd: FAR_IP },
  ),
  adapterCase(
    "tunnel, IP far end: verify-full refuses a certificate issued for 127.0.0.1 only",
    (ports) => forwarded(ports.ipOnly, { mode: "verify-full", caCert: read("ca.crt") }),
    () => tlsFailure("name", /IP: 10\.0\.0\.5 is not in the cert's list: 127\.0\.0\.1/, doesNotName("10.0.0.5")),
    { farEnd: FAR_IP },
  ),
  adapterCase(
    "tunnel, DNS far end: require connects, to a certificate that names neither end",
    (ports) => forwarded(ports.farIp, { mode: "require" }),
    () => connected(),
    { farEnd: FAR_DNS },
  ),
  adapterCase(
    "tunnel, IP far end: require connects, to a certificate that names neither end",
    (ports) => forwarded(ports.farDns, { mode: "require" }),
    () => connected(),
    { farEnd: FAR_IP },
  ),
  // -- spec E5: TLS failures stay failures, and plaintext is never tried instead
  adapterCase(
    TLS_TO_PLAINTEXT,
    (ports) => direct("127.0.0.1", ports.plaintext, { mode: "require" }),
    () => tlsFailure("not-tls", /wrong version number|WRONG_VERSION_NUMBER/, NOT_TLS),
  ),
  adapterCase(
    "plaintext to a TLS port fails to connect",
    (ports) => direct("127.0.0.1", ports.selfSigned),
    (ports) => () => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      text: /Last error: Failed to connect/,
      sentence: noPlaintextAnswer(`127.0.0.1:${ports.selfSigned}`),
    }),
  ),
  // -- spec 5.6: transport failures against local listeners
  adapterCase(
    "a listener that never answers is a connect timeout: the request never left",
    (ports) => direct("127.0.0.1", ports.silent),
    (ports) => () => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 4,
      text: /^Deadline exceeded after [\d.]+s,.*Waiting for LB pick$/,
      sentence: noPlaintextAnswer(`127.0.0.1:${ports.silent}`),
    }),
    { timeoutMs: 500 },
  ),
  adapterCase(
    "a socket reset on accept is a failure to connect",
    (ports) => direct("127.0.0.1", ports.resetting),
    (ports) => (runtime) => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      // Node reports the reset as the read's ECONNRESET, or, when the session closes first, as Bun always does (measured
      // under Node 24.14.0: 7 runs in 8 read ECONNRESET).
      text: runtime === "node" ? /Last error: (?:read ECONNRESET|Failed to connect)/ : /Last error: Failed to connect/,
      sentence: noPlaintextAnswer(`127.0.0.1:${ports.resetting}`),
    }),
  ),
  adapterCase(
    "a refused socket is a failure to connect",
    (ports) => direct("127.0.0.1", ports.closed),
    (ports) => () => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      text: /ECONNREFUSED/,
      sentence: noPlaintextAnswer(`127.0.0.1:${ports.closed}`),
    }),
  ),
  // -- spec E5: the control, which takes the branch its runtime's version takes
  {
    name: "control: grpc-js alone, with an IP target and no override, takes its runtime's branch",
    phase: "dialled",
    make: (ports) => ({
      name: "control: grpc-js alone, with an IP target and no override, takes its runtime's branch",
      via: "control",
      target: `dns:127.0.0.1:${ports.selfSigned}`,
      tls: true,
      timeoutMs: TIMEOUT_MS,
    }),
    expected: () => (runtime, nodeRefusesIpServerName) =>
      runtime === "bun" || nodeRefusesIpServerName
        ? { outcome: "failed", grpcCode: 14, text: /ERR_INVALID_ARG_VALUE/ }
        : { outcome: "connected" },
  },
];

/**
 * Known defects under Bun, pinned as they are so that the fix fails them (found by Task 13b). errors.ts's TLS_CAUSES
 * reads Node's texts only: Bun writes "self signed certificate" where Node writes "self-signed certificate", and
 * BoringSSL "WRONG_VERSION_NUMBER" where OpenSSL writes "wrong version number". So under Bun both failures lose their
 * cause and read "this runtime does not report why", although Bun reported it, where spec 5.6 gives the chain and the
 * not-TLS sentences. When TLS_CAUSES reads both texts, delete these entries: each case's own expectation, the spec's,
 * then holds under Bun too.
 */
const BUN_KNOWN_DEFECTS: ReadonlyMap<string, (ports: Listeners) => Expected> = new Map([
  [
    VERIFY_FULL_SELF_SIGNED,
    (ports: Listeners): Expected => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      text: /Last error: Error: self signed certificate\. /,
      sentence: noTlsAnswer("bun", `localhost:${ports.selfSigned}`, false),
    }),
  ],
  [
    VERIFY_SYSTEM_SELF_SIGNED,
    (ports: Listeners): Expected => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      text: /Last error: Error: self signed certificate\. /,
      sentence: noTlsAnswer("bun", `localhost:${ports.selfSigned}`, false),
    }),
  ],
  [
    TLS_TO_PLAINTEXT,
    (ports: Listeners): Expected => ({
      outcome: "failed",
      category: "not-connected",
      grpcCode: 14,
      text: /Last error: Error: error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER\. /,
      sentence: noTlsAnswer("bun", `127.0.0.1:${ports.plaintext}`, false),
    }),
  ],
]);

const CASE_NAMES = CASES.map((definition) => definition.name);

const DEPS: RunnerDeps = {
  grpc,
  createGrpcEtcdClient,
  grpcWireTransport,
  buildEtcdConnectionOptions,
  etcdErrorConnection,
  toProviderError,
  TUNNEL_FAR_END,
};

/** One run of every case under one runtime: the outcomes by case name, and what each listener saw in each phase. */
interface Run {
  readonly outcomes: ReadonlyMap<string, HandshakeOutcome>;
  readonly seenWhileUndialled: Readonly<Record<string, number>>;
  readonly seenWhileDialled: Readonly<Record<string, number>>;
  /** `process.version` of the Node child; absent for the run under Bun. */
  readonly version?: string;
  /** The sockets that still kept the Node child running after its cases, by resource type; absent under Bun. */
  readonly openSockets?: readonly string[];
}

/** Runs both phases through `run`, reading every listener's count before and after each. */
async function runPhases(run: (cases: readonly HandshakeCase[]) => Promise<HandshakeOutcome[]>) {
  const outcomes = new Map<string, HandshakeOutcome>();
  const seen: Record<string, Record<string, number>> = {};
  for (const phase of ["undialled", "dialled"] as const) {
    const before = { ...counts };
    const cases = CASES.filter((definition) => definition.phase === phase).map((definition) =>
      definition.make(listeners),
    );
    // oxlint-disable-next-line no-await-in-loop -- the undialled phase ends before the dialled one starts, so its counts are its own.
    for (const outcome of await run(cases)) outcomes.set(outcome.name, outcome);
    seen[phase] = Object.fromEntries(Object.keys(counts).map((name) => [name, counts[name] - before[name]]));
  }
  return { outcomes, seenWhileUndialled: seen.undialled, seenWhileDialled: seen.dialled };
}

/** The spec's expectation for a case under a runtime, or, under Bun, the known defect it is pinned to. */
function expectationOf(definition: CaseDefinition, runtime: Runtime, version: string | undefined): Expected {
  const defect = runtime === "bun" ? BUN_KNOWN_DEFECTS.get(definition.name) : undefined;
  if (defect !== undefined) return defect(listeners);
  const major = version === undefined ? 0 : Number(/^v(\d+)\./.exec(version)?.[1]);
  return definition.expected(listeners)(runtime, major >= 25);
}

function expectCase(run: Run | undefined, runtime: Runtime, name: string): void {
  if (run === undefined) throw new Error("The cases did not run: see the failure of this block's beforeAll");
  const definition = CASES.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`No case is named ${name}`);
  const made = definition.make(listeners);
  const expected = expectationOf(definition, runtime, run.version);
  const outcome = run.outcomes.get(name);
  // The whole outcome rides in every failure message, so a changed text shows itself without a second run.
  const shown = JSON.stringify(outcome);
  expect({ shown, outcome: outcome?.outcome }).toEqual({ shown, outcome: expected.outcome });
  if (outcome === undefined) return;
  if (expected.target !== undefined)
    expect({ shown, target: "target" in outcome && outcome.target }).toEqual({ shown, target: expected.target });
  if (outcome.outcome === "refused") {
    expect(outcome as object).toEqual({
      name,
      outcome: "refused",
      errorClass: "DatabaseConfigError",
      message: expected.message,
    });
    return;
  }
  if (outcome.outcome !== "failed") return;
  // Spec E5: the code the runtime gave, and its text.
  expect({ shown, code: outcome.raw?.code }).toEqual({ shown, code: expected.grpcCode });
  if (expected.text !== undefined) expect(outcome.raw?.details).toMatch(expected.text);
  if (made.via === "control") return;
  // The adapter's classification, which keeps the runtime's code.
  expect({ shown, category: outcome.category, tlsFailure: outcome.tlsFailure, grpcCode: outcome.grpcCode }).toEqual({
    shown,
    category: expected.category,
    tlsFailure: expected.tlsFailure,
    grpcCode: outcome.raw?.code,
  });
  // Spec E5 and 5.6: a ConnectionError, the provider's sentence first, the runtime's words after it (E16).
  const message = String(outcome.message);
  const sentence = String(expected.sentence);
  expect({ shown, errorClass: outcome.errorClass, lead: message.slice(0, sentence.length) }).toEqual({
    shown,
    errorClass: "ConnectionError",
    lead: sentence,
  });
  expect(message.slice(sentence.length)).toMatch(/^ \([\s\S]+\)$/);
  // A connection error never names a tunnel's local forward (plan Global Constraints, D-T11-12).
  if (made.farEnd !== undefined) expect(message).not.toContain(String(made.connection.port));
}

/** What the listeners must have seen, which is the same under either runtime (spec E1, E5). */
function expectListeners(run: Run | undefined): void {
  if (run === undefined) throw new Error("The cases did not run: see the failure of this block's beforeAll");
  // Nothing at all was accepted or answered while the refused endpoints and the resolver-named hosts were tried.
  expect(run.seenWhileUndialled).toEqual(Object.fromEntries(Object.keys(counts).map((name) => [name, 0])));
  // The controls: the same `::1` listener saw both spellings of the host, and the Unix socket saw grpc-js's dial.
  expect(run.seenWhileDialled.loopback6).toBeGreaterThanOrEqual(2);
  expect(run.seenWhileDialled.unix).toBeGreaterThanOrEqual(1);
  // A TLS connection that failed was never tried again in plaintext: the plaintext server answered no call.
  expect(run.seenWhileDialled.plaintext).toBe(0);
  // A refused handshake reached no handler.
  expect(run.seenWhileDialled.otherHost).toBe(0);
  expect(run.seenWhileDialled.localForward).toBe(0);
}

describe("the certificates and the known defects (spec E5)", () => {
  test("no certificate a tunnel-shaped connection verifies or passes carries 127.0.0.1 or localhost", () => {
    for (const name of ["far-dns", "far-ip"]) {
      const names = new X509Certificate(read(`${name}.crt`)).subjectAltName ?? "";
      expect({ name, names }).toEqual({ name, names: name === "far-dns" ? "DNS:etcd.test" : "IP Address:10.0.0.5" });
    }
  });

  test("every known defect names a case, so a renamed case cannot leave its entry behind", () => {
    expect([...BUN_KNOWN_DEFECTS.keys()].filter((name) => !CASE_NAMES.includes(name))).toEqual([]);
  });
});

describe("under Bun (spec E1, E5, 5.6)", () => {
  let run: Run | undefined;
  beforeAll(async () => {
    const workingDirectory = process.cwd();
    // The Unix socket is named after a port in the working directory, which is where grpc-js looks for `unix:<port>`.
    process.chdir(dir);
    try {
      run = await runPhases((cases) => runCases(DEPS, cases));
    } finally {
      process.chdir(workingDirectory);
    }
  }, 90_000);

  test.each(
    CASE_NAMES.map((name) => [BUN_KNOWN_DEFECTS.has(name) ? `${name} (a known defect, pinned as it is)` : name, name]),
  )("%s", (_title, name) => expectCase(run, "bun", name));
  test("the listeners saw only what spec E1 and E5 allow", () => expectListeners(run));
});

describe("in a Node child, the production runtime (spec E5)", () => {
  let run: Run | undefined;
  beforeAll(async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "No node on PATH: this block runs every case under Node, the production runtime; install Node 24 or later",
      );
    }
    // The child runs a bundle of the adapter's own modules around the text of `runCases`, because Node loads
    // neither TypeScript with `@/` imports nor this file, which is a bun:test file.
    const from = (file: string) => JSON.stringify(join(ETCD_SOURCES, file));
    writeFileSync(
      at("child.ts"),
      [
        `import * as grpc from ${JSON.stringify(Bun.resolveSync("@grpc/grpc-js", import.meta.dir))};`,
        'import { readFileSync } from "node:fs";',
        `import { buildEtcdConnectionOptions, etcdErrorConnection } from ${from("connection-options.ts")};`,
        `import { toProviderError } from ${from("errors.ts")};`,
        `import { createGrpcEtcdClient, grpcWireTransport } from ${from("grpc-client.ts")};`,
        `import { TUNNEL_FAR_END } from ${JSON.stringify(join(ETCD_SOURCES, "../../../../types.ts"))};`,
        `const runCases = ${runCases.toString()};`,
        "const deps = { grpc, createGrpcEtcdClient, grpcWireTransport, buildEtcdConnectionOptions, etcdErrorConnection, toProviderError, TUNNEL_FAR_END };",
        'const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));',
        "const outcomes = await runCases(deps, cases);",
        // Spec E16: every client a case built is closed by then, so once the sockets closing have closed, none keeps
        // the child running. It reports any that does, and exits, where that socket would keep it running until the
        // runner's budget ends the file.
        'const openSockets = () => process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap" || name === "TLSWrap");',
        "for (const until = Date.now() + 2000; openSockets().length > 0 && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 50));",
        "process.stdout.write(JSON.stringify({ version: process.version, outcomes, openSockets: openSockets() }), () => process.exit(0));",
        "",
      ].join("\n"),
    );
    const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
    if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
    let version: string | undefined;
    const openSockets: string[] = [];
    const phases = await runPhases(async (cases) => {
      writeFileSync(at("cases.json"), JSON.stringify(cases));
      const child = Bun.spawn([node, at("child.js"), at("cases.json")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`The Node child exited ${exitCode}: ${stderr}`);
      const answer = JSON.parse(stdout) as {
        readonly version: string;
        readonly outcomes: HandshakeOutcome[];
        readonly openSockets: string[];
      };
      version = answer.version;
      openSockets.push(...answer.openSockets);
      return answer.outcomes;
    });
    run = { ...phases, version, openSockets };
  }, 150_000);

  test("the child is Node, and says which version ran the cases", () => {
    expect(run?.version).toMatch(/^v\d+\.\d+\.\d+/);
    console.log(`tls-handshake: the Node child ran as ${run?.version}`);
  });
  test.each(CASE_NAMES)("%s", (name) => expectCase(run, "node", name));
  test("the listeners saw only what spec E1 and E5 allow", () => expectListeners(run));
  test("once its cases are done, no socket keeps the child running (spec E16)", () => {
    expect(run?.openSockets).toEqual([]);
  });
});
