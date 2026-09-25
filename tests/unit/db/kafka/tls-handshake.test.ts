/**
 * Real TLS handshakes and real transport failures through the real client library,
 * against local servers this file starts (spec 10, gate 1). Every TLS server closes each
 * connection once its handshake completes, so a handshake that succeeds is observed as a
 * secureConnection on the server followed by a non-TLS failure on the client, and a handshake
 * the client refuses is a KafkaError "tls" carrying the code the runtime gave it (spec 3.6 K7).
 * One the server refuses is the exception K7 states: under TLS 1.3, which these servers
 * negotiate, a server that requires a client certificate refuses, after the client's half of the
 * handshake, a client whose certificate is missing or untrusted, so the library reports only that
 * the connection closed, which the adapter reads as network connection-lost, and this file
 * observes that refusal on the server alone.
 *
 * Each TLS mode goes through kafkaConnectionOptions from a connection as a user saves it, so
 * "verify-full", "verify-ca" and "require" are the dialog's modes, not hand-built options.
 * The certificates are made here with openssl, into a temporary directory, and never committed;
 * openssl reads only this file's own config, never the platform's default one.
 *
 * The transport block drives the library against listeners that fail in each way the error
 * translation tells apart by the library's own fixed text ("Connection to <host>:<port>
 * failed." and "timed out.", "Connection closed", "Request timed out", "Broker requires TLS.",
 * "TLS handshake failed"), so a library upgrade that changes one fails here (spec 5.6).
 *
 * Bun sends a TLS server name unasked and Node does not, so the handshakes below cannot tell
 * whether the option that makes Node send one works. The last block runs the library under
 * Node, the production runtime, with exactly the options the adapter builds for a DNS host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import type { DatabaseConnection, SSLConfig } from "@/lib/types";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";
import {
  createPlatformaticClient,
  loadPlatformatic,
  translateError,
} from "@/lib/db/providers/stream/kafka/platformatic-client";
import { recordedLib } from "../../../helpers/kafka-fixtures";

const dir = mkdtempSync(join(tmpdir(), "kafka-tls-"));
const at = (file: string) => join(dir, file);
const read = (file: string) => readFileSync(at(file), "utf8");

/**
 * The only config openssl reads here, given to `req` and set as OPENSSL_CONF for every command: a
 * certificate request needs a distinguished_name section, and no default config can be assumed
 * where the Windows and macOS runners' openssl would look for one.
 */
const OPENSSL_CONFIG = "openssl.cnf";
const OPENSSL_CONF = [
  "[req]",
  "distinguished_name = dn",
  "[dn]",
  "[authority]",
  "basicConstraints = critical, CA:TRUE",
  "keyUsage = critical, keyCertSign, cRLSign",
  "subjectKeyIdentifier = hash",
  "[self_signed]",
  "basicConstraints = critical, CA:FALSE",
  "subjectAltName = DNS:localhost, IP:127.0.0.1",
  "extendedKeyUsage = serverAuth",
  "",
].join("\n");

function openssl(...args: string[]): void {
  const run = Bun.spawnSync(["openssl", ...args], {
    cwd: dir,
    env: { ...process.env, OPENSSL_CONF: at(OPENSSL_CONFIG) },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${run.stderr.toString()}`);
}

/** A new RSA key and its certificate request, or with `-x509` its self-signed certificate. */
function req(...args: string[]): void {
  openssl("req", "-config", OPENSSL_CONFIG, "-newkey", "rsa:2048", "-nodes", "-sha256", ...args);
}

/** A certificate authority, self-signed. */
function authority(name: string): void {
  req(
    "-x509",
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    "-extensions",
    "authority",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.crt`,
  );
}

/** A certificate `issuer` signs for `subject`, with the given extensions. */
function leaf(name: string, subject: string, issuer: string, serial: number, extensions: string[]): void {
  writeFileSync(at(`${name}.ext`), `${extensions.join("\n")}\n`);
  req("-subj", `/CN=${subject}`, "-keyout", `${name}.key`, "-out", `${name}.csr`);
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${issuer}.crt`,
    "-CAkey",
    `${issuer}.key`,
    "-set_serial",
    String(serial),
    "-sha256",
    "-days",
    "1",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  );
}

const SERVER_NAMES = "subjectAltName = DNS:localhost, IP:127.0.0.1";

/** A local TLS server that closes each connection once its handshake completes, and what it saw. */
interface LocalTlsServer {
  readonly port: number;
  /** Completed handshakes; a server that requires a client certificate completes only authorized ones. */
  readonly handshakes: number;
  /**
   * The server name each completed handshake asked for. Bun's server records a missing one as
   * undefined, though Node's types say false or null, so these are compared with toStrictEqual:
   * toEqual passes an array of undefined as an empty one.
   */
  readonly names: ReadonlyArray<string | false | null | undefined>;
  /** Connections that failed before their handshake completed, the server's tlsClientError. */
  readonly refusals: number;
  close(): void;
}

async function tlsServer(options: tls.TlsOptions): Promise<LocalTlsServer> {
  const names: Array<string | false | null | undefined> = [];
  let handshakes = 0;
  let refusals = 0;
  const server = tls.createServer(options, (socket) => {
    handshakes++;
    names.push(socket.servername);
    socket.destroy();
  });
  server.on("tlsClientError", () => {
    refusals++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    get handshakes() {
      return handshakes;
    },
    names,
    get refusals() {
      return refusals;
    },
    close: () => server.close(),
  };
}

/** A saved Kafka connection, the shape the dialog writes (the type-id lands with the registration). */
const connection = (host: string, port: number, ssl?: SSLConfig) =>
  ({
    id: "kafka-tls",
    name: "kafka-tls",
    type: "kafka",
    host,
    port,
    ...(ssl === undefined ? {} : { ssl }),
    createdAt: new Date(),
  }) as unknown as DatabaseConnection;

/** The rejection of a read that must fail; a read that answers fails the test here. */
async function failure(read: Promise<unknown>): Promise<unknown> {
  return read.then(
    () => {
      throw new Error("The read answered, though no server this file starts can answer one");
    },
    (error: unknown) => error,
  );
}

let privateCa: LocalTlsServer;
let selfSigned: LocalTlsServer;
let clientAuthOnly: LocalTlsServer;
let mutual: LocalTlsServer;

beforeAll(async () => {
  if (Bun.which("openssl") === null) {
    throw new Error(
      "No openssl on PATH: this file makes its certificates at test time, and none are committed; install OpenSSL",
    );
  }
  writeFileSync(at(OPENSSL_CONFIG), OPENSSL_CONF);
  authority("ca");
  authority("other-ca");
  leaf("broker", "localhost", "ca", 1, ["basicConstraints = CA:FALSE", SERVER_NAMES, "extendedKeyUsage = serverAuth"]);
  // Issued by the broker's CA for the broker's names, but for client authentication only.
  leaf("client-auth-only", "localhost", "ca", 2, [
    "basicConstraints = CA:FALSE",
    SERVER_NAMES,
    "extendedKeyUsage = clientAuth",
  ]);
  leaf("client", "libredb-studio-test-client", "ca", 3, [
    "basicConstraints = CA:FALSE",
    "extendedKeyUsage = clientAuth",
  ]);
  req(
    "-x509",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-extensions",
    "self_signed",
    "-keyout",
    "self-signed.key",
    "-out",
    "self-signed.crt",
  );
  const broker = { key: read("broker.key"), cert: read("broker.crt") };
  privateCa = await tlsServer(broker);
  selfSigned = await tlsServer({ key: read("self-signed.key"), cert: read("self-signed.crt") });
  clientAuthOnly = await tlsServer({ key: read("client-auth-only.key"), cert: read("client-auth-only.crt") });
  mutual = await tlsServer({ ...broker, requestCert: true, rejectUnauthorized: true, ca: read("ca.crt") });
});

afterAll(() => {
  for (const server of [privateCa, selfSigned, clientAuthOnly, mutual]) server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One listing through the adapter over the saved connection `ssl` describes, and whether the server completed a handshake. */
async function attempt(server: LocalTlsServer, ssl: SSLConfig) {
  const before = server.handshakes;
  const client = createPlatformaticClient(
    kafkaConnectionOptions(connection("localhost", server.port, ssl), 3000),
    await loadPlatformatic(),
  );
  const error = await failure(client.listTopics());
  await client.close();
  expect(error).toBeInstanceOf(KafkaError);
  return { error: error as KafkaError, handshook: server.handshakes > before };
}

const ca = () => read("ca.crt");

describe("TLS handshakes through the real client", () => {
  test("verify-full with no CA rejects a server a private CA signed, carrying the code (K7)", async () => {
    const { error, handshook } = await attempt(privateCa, { mode: "verify-full" });
    expect([error.category, error.detail]).toStrictEqual(["tls", { nodeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }]);
    expect(handshook).toBe(false);
  }, 20_000);

  test("verify-full with no CA rejects a self-signed server", async () => {
    const { error, handshook } = await attempt(selfSigned, { mode: "verify-full" });
    expect([error.category, error.detail]).toStrictEqual(["tls", { nodeCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }]);
    expect(handshook).toBe(false);
  }, 20_000);

  test("require accepts the self-signed server, because it verifies nothing", async () => {
    const { error, handshook } = await attempt(selfSigned, { mode: "require" });
    expect(handshook).toBe(true);
    expect(error.category).not.toBe("tls");
  }, 20_000);

  test("verify-ca with the right CA completes the handshake, naming the server it asked for", async () => {
    const { error, handshook } = await attempt(privateCa, { mode: "verify-ca", caCert: ca() });
    expect(handshook).toBe(true);
    expect(error.category).not.toBe("tls");
    // Bun names the server unasked; the last block shows the option at work under Node.
    expect(privateCa.names.at(-1)).toBe("localhost");
  }, 20_000);

  test("a wrong CA rejects", async () => {
    const { error, handshook } = await attempt(privateCa, { mode: "verify-ca", caCert: read("other-ca.crt") });
    expect([error.category, error.detail]).toStrictEqual(["tls", { nodeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }]);
    expect(handshook).toBe(false);
  }, 20_000);

  test("rejectUnauthorized false overrides verify-full, which rejects the same server without it", async () => {
    const { error, handshook } = await attempt(privateCa, { mode: "verify-full", rejectUnauthorized: false });
    expect(handshook).toBe(true);
    expect(error.category).not.toBe("tls");
  }, 20_000);

  test("a server certificate for client authentication only is refused as INVALID_PURPOSE, tls at the bootstrap and at an advertised address (K7)", async () => {
    // The control is verify-ca's handshake above, whose options verify-full builds too: the same CA
    // issued the broker's certificate for the same names, and of what a verifier checks, only the
    // extended key usage tells the two apart.
    const { error, handshook } = await attempt(clientAuthOnly, { mode: "verify-full", caCert: ca() });
    expect([error.category, error.detail]).toStrictEqual(["tls", { nodeCode: "INVALID_PURPOSE" }]);
    expect(handshook).toBe(false);
    const lib = await loadPlatformatic();
    const admin = new lib.Admin({
      clientId: "libredb-studio",
      bootstrapBrokers: [{ host: "localhost", port: clientAuthOnly.port }],
      retries: 0,
      connectTimeout: 3000,
      requestTimeout: 3000,
      tls: { ca: ca(), rejectUnauthorized: true },
    });
    const raw = await failure(admin.listTopics());
    await admin.close();
    // Read as if another bootstrap had led here: at an address the broker advertised, a refused
    // certificate is still tls, never a broker this server cannot reach.
    const advertised = translateError(raw, { host: "127.0.0.2", port: 1 });
    expect([advertised.category, advertised.detail]).toStrictEqual(["tls", { nodeCode: "INVALID_PURPOSE" }]);
  }, 20_000);

  test("the TLS panel's client certificate reaches the handshake: a server that requires one completes it", async () => {
    const client = { clientCert: read("client.crt"), clientKey: read("client.key") };
    const presented = await attempt(mutual, { mode: "verify-full", caCert: ca(), ...client });
    expect(presented.handshook).toBe(true);
    expect(presented.error.category).not.toBe("tls");
    // The control, which makes the assertion above able to fail: without the certificate this
    // server completes no handshake and refuses the connection. How the client reads that refusal
    // is not asserted: under TLS 1.3 the server refuses a client certificate after the client's
    // half of the handshake, and the library reports only that the connection closed.
    const refusals = mutual.refusals;
    const withheld = await attempt(mutual, { mode: "verify-full", caCert: ca() });
    expect(withheld.handshook).toBe(false);
    expect(mutual.refusals).toBeGreaterThan(refusals);
  }, 20_000);
});

/** A plaintext listener with the given behaviour on each connection, and its port. */
async function listener(onConnection: (socket: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  const plain = net.createServer(onConnection);
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  return { port: (plain.address() as AddressInfo).port, close: () => plain.close() };
}

async function readAgainst(target: number, ssl?: SSLConfig): Promise<KafkaError> {
  const client = createPlatformaticClient(
    kafkaConnectionOptions(connection("127.0.0.1", target, ssl), 1000),
    await loadPlatformatic(),
  );
  const error = await failure(client.listTopics());
  await client.close();
  expect(error).toBeInstanceOf(KafkaError);
  return error as KafkaError;
}

describe("transport failures through the real client", () => {
  test("a broker that accepts and never answers is a timeout, though the library's TimeoutError carries a network code", async () => {
    const silent = await listener(() => {});
    const error = await readAgainst(silent.port);
    silent.close();
    expect([error.category, error.detail]).toStrictEqual(["timeout", {}]);
  }, 20_000);

  test("a broker that closes the connection is a network failure, a connection lost", async () => {
    const closing = await listener((socket) => socket.destroy());
    const error = await readAgainst(closing.port);
    closing.close();
    expect([error.category, error.detail]).toStrictEqual(["network", { nodeCode: "connection-lost" }]);
  }, 20_000);

  test("a plaintext read answered with a TLS alert record is told the broker requires TLS", async () => {
    // A TLS alert, which the library's first-read check recognises (dist/network/connection.js #isTLSRecord).
    const alerting = await listener((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => socket.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])));
    });
    const error = await readAgainst(alerting.port);
    alerting.close();
    expect([error.category, error.detail]).toStrictEqual(["tls", {}]);
    expect(error.message).toContain("requires TLS");
  }, 20_000);

  test("a TLS read against a plaintext listener is a failed handshake, not a network failure", async () => {
    // The listener drops the ClientHello, which is what a plaintext broker does; the ECONNRESET
    // under the library's "TLS handshake failed" would read as a network failure on its own.
    const plaintext = await listener((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => socket.destroy());
    });
    const error = await readAgainst(plaintext.port, { mode: "require" });
    plaintext.close();
    expect([error.category, error.detail]).toStrictEqual(["tls", { nodeCode: "ECONNRESET" }]);
  }, 20_000);

  test("a TLS connect that is never answered times out at the connect, read from the library's own text", async () => {
    const silent = await listener((socket) => socket.on("error", () => undefined));
    const error = await readAgainst(silent.port, { mode: "require" });
    silent.close();
    expect([error.category, error.detail]).toStrictEqual(["network", { nodeCode: "connect-timeout" }]);
  }, 20_000);

  test("the address a failure names is read from the library's text, so an advertised broker is named, not the bootstrap", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const lib = await loadPlatformatic();
    const admin = new lib.Admin({
      clientId: "libredb-studio",
      bootstrapBrokers: [{ host: "localhost", port: closedPort }],
      retries: 0,
      // Windows retries a refused connect for about 1 to 2 s; a 1 s timer would fire first
      // and turn ECONNREFUSED into connect-timeout on the Cross-platform leg.
      connectTimeout: 10_000,
      requestTimeout: 1000,
    });
    const raw = await failure(admin.listTopics());
    await admin.close();
    // Read as if another bootstrap had led here: the only source of "localhost" and this port
    // is the library's "Connection to <host>:<port> failed.", since Node names the address it resolved.
    expect(translateError(raw, { host: "127.0.0.2", port: 1 })).toMatchObject({
      category: "advertised-unreachable",
      detail: { host: "localhost", port: closedPort, nodeCode: "ECONNREFUSED" },
    });
  }, 20_000);

  test("the library's protocol logger stays off under DEBUG, so no request frame reaches stderr (spec K3)", async () => {
    const silent = await listener(() => {});
    const adapter = pathToFileURL(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "db",
        "providers",
        "stream",
        "kafka",
        "platformatic-client.ts",
      ),
    ).href;
    const script = [
      `const m = await import(${JSON.stringify(adapter)});`,
      `const c = m.createPlatformaticClient({ clientId: "libredb-studio", broker: { host: "127.0.0.1", port: ${silent.port} }, timeoutMs: 500 }, await m.loadPlatformatic());`,
      "await c.listTopics().catch(() => undefined);",
      "await c.close();",
    ].join("\n");
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, DEBUG: "plt:kafka:*" },
      stderr: "pipe",
      stdout: "pipe",
    });
    silent.close();
    const stderr = run.stderr.toString();
    // Compared whole, so a child that failed shows its stderr.
    expect({ exitCode: run.exitCode, stderr }).toMatchObject({ exitCode: 0 });
    // The client logger still writes, which proves DEBUG reached the child.
    expect(stderr).toContain("plt:kafka:client");
    expect(stderr).not.toContain("plt:kafka:protocol");
  }, 20_000);
});

describe("the TLS server name under Node, the production runtime (spec 6.1)", () => {
  test("the options the adapter builds for a DNS host make Node send that name, and without them Node sends none", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "No node on PATH: this test runs the client under Node, the production runtime; install Node 24 or later",
      );
    }
    // The adapter is TypeScript with extensionless imports, which Node does not load, so the
    // child runs the library itself with exactly the options the adapter hands its Admin for
    // the connection a user saves with a DNS host.
    const { lib, constructed } = recordedLib();
    createPlatformaticClient(
      kafkaConnectionOptions(connection("localhost", privateCa.port, { mode: "verify-full", caCert: ca() }), 3000),
      lib,
    );
    const adapterOptions = constructed.find(([name]) => name === "Admin")?.[1] as Record<string, unknown>;
    expect(adapterOptions.tlsServerName).toBe(true);
    const control = Object.fromEntries(Object.entries(adapterOptions).filter(([key]) => key !== "tlsServerName"));
    const library = pathToFileURL(Bun.resolveSync("@platformatic/kafka", import.meta.dir)).href;
    const namesUnderNode = async (options: Record<string, unknown>) => {
      const script = at("server-name-under-node.mjs");
      writeFileSync(
        script,
        [
          `const { Admin } = await import(${JSON.stringify(library)});`,
          `const admin = new Admin(${JSON.stringify(options)});`,
          "await admin.listTopics().catch(() => undefined);",
          "await admin.close();",
        ].join("\n"),
      );
      const before = privateCa.names.length;
      // Asynchronous, so this process keeps answering the handshakes the child starts.
      const child = Bun.spawn([node, script], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(child.stderr).text();
      // Compared whole, so a child that failed shows its stderr.
      expect({ exitCode: await child.exited, stderr }).toMatchObject({ exitCode: 0 });
      return privateCa.names.slice(before);
    };
    const named = await namesUnderNode(adapterOptions);
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)]).toStrictEqual(["localhost"]);
    // The control, which makes the assertion above able to fail: unasked, Node sends no name.
    const unnamed = await namesUnderNode(control);
    expect(unnamed.length).toBeGreaterThan(0);
    expect(unnamed.filter((name) => typeof name === "string")).toStrictEqual([]);
  }, 30_000);
});
