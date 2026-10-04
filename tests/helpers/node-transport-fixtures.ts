/**
 * Local listeners and throwaway certificates for the node-transport tests (vector-family spec 3.7).
 *
 * Every listener binds a loopback address on a port the system picks, counts the connections it accepts, records every
 * request that reaches its handler, and is closed by closeAll(). So "nothing was sent" and "the socket was closed" are
 * measured on the server side, not assumed from the client's side.
 *
 * The certificates are made with openssl into a temporary directory when a test file asks for them, read into memory,
 * and the directory is removed at once: none is committed, as the etcd handshake tests make theirs
 * (tests/unit/db/etcd/tls-handshake.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, createServer as createTcpServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { constants, createGzip } from "node:zlib";

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  /** The TLS server name the client sent, false when it sent none; absent over plaintext. */
  readonly servername?: string | false;
}

export interface Listener {
  readonly port: number;
  /** Every request that reached the handler, in order. */
  readonly seen: Seen[];
  /** TCP connections accepted so far. */
  accepted(): number;
  /** Connections accepted and not yet closed. */
  open(): number;
  close(): Promise<void>;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export interface Pair {
  readonly cert: string;
  readonly key: string;
}

export interface TransportCertificates {
  /** The test CA, which signed every server and client certificate below except `second`. */
  readonly ca: string;
  /** A CA that signed nothing a listener presents. */
  readonly rogueCa: string;
  /** A second CA, which signed `second` only. */
  readonly secondCa: string;
  /** DNS:localhost, IP:127.0.0.1 and IP:::1. */
  readonly local: Pair;
  /** DNS:localhost, signed by `secondCa`. */
  readonly second: Pair;
  /** DNS:qdrant.test: a tunnel's far end by name. */
  readonly farName: Pair;
  /** IP:10.0.0.5: a tunnel's far end by address. */
  readonly farAddress: Pair;
  /** DNS:guard.test: the host the guarded-lookup tests dial. */
  readonly guarded: Pair;
  /** A client certificate, for a server that requires one. */
  readonly client: Pair;
}

const closers: Array<() => Promise<void>> = [];

function observe(server: NetServer, seen: Seen[], host: string): Promise<Listener> {
  let accepted = 0;
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      };
      closers.push(close);
      resolve({
        port: (server.address() as AddressInfo).port,
        seen,
        accepted: () => accepted,
        open: () => sockets.size,
        close,
      });
    });
  });
}

function recording(handler: Handler, seen: Seen[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const socket = request.socket as Partial<TLSSocket>;
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
        ...(socket.encrypted === true ? { servername: socket.servername ?? false } : {}),
      });
      handler(request, response, body);
    });
  };
}

/** A plaintext HTTP listener on `host` that hands each request, read whole, to `handler`. */
export function httpListener(handler: Handler, host = "127.0.0.1"): Promise<Listener> {
  const seen: Seen[] = [];
  return observe(createHttpServer(recording(handler, seen)), seen, host);
}

/** An HTTPS listener presenting `material`; with `clientCa`, it requires a client certificate that CA signed. */
export function httpsListener(
  material: Pair & { readonly clientCa?: string },
  handler: Handler,
  host = "127.0.0.1",
): Promise<Listener> {
  const seen: Seen[] = [];
  const server = createHttpsServer(
    {
      cert: material.cert,
      key: material.key,
      ...(material.clientCa === undefined
        ? {}
        : { ca: material.clientCa, requestCert: true, rejectUnauthorized: true }),
    },
    recording(handler, seen),
  );
  return observe(server, seen, host);
}

/** An answer with `status`, a JSON content type, `headers` and the body `text`. */
export function jsonAnswer(status: number, text: string, headers: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(text);
  };
}

/** Closes every listener this process opened. */
export async function closeAll(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()));
}

/** Resolves once `check` holds, or rejects naming `what` after `ms`. */
export async function eventually(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polling a listener's own counters.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The certificates of TransportCertificates, made with openssl and never written anywhere that outlives this call. */
export function makeCertificates(): TransportCertificates {
  if (Bun.which("openssl") === null) {
    throw new Error(
      "No openssl on PATH: the node-transport TLS tests make their certificates at test time, and none are committed; install OpenSSL",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "node-transport-tls-"));
  const at = (file: string) => join(dir, file);
  const env = { ...process.env, OPENSSL_CONF: at("openssl.cnf") };
  const openssl = (...args: string[]): void => {
    const run = Bun.spawnSync(["openssl", ...args], { cwd: dir, env, stdout: "ignore", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${run.stderr.toString()}`);
  };
  let serial = 2000;
  const make = (name: string, subject: string, extensions: readonly string[], issuer = name): Pair => {
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
    return { cert: readFileSync(at(`${name}.crt`), "utf8"), key: readFileSync(at(`${name}.key`), "utf8") };
  };
  try {
    writeFileSync(at("openssl.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n");
    const caExtensions = ["basicConstraints = critical, CA:TRUE", "keyUsage = critical, keyCertSign, cRLSign"];
    const server = (names: string) => [
      "basicConstraints = CA:FALSE",
      `subjectAltName = ${names}`,
      "extendedKeyUsage = serverAuth",
    ];
    const ca = make("ca", "node-transport-test-ca", caExtensions);
    const rogueCa = make("rogue-ca", "node-transport-rogue-ca", caExtensions);
    const secondCa = make("second-ca", "node-transport-second-ca", caExtensions);
    return {
      ca: ca.cert,
      rogueCa: rogueCa.cert,
      secondCa: secondCa.cert,
      local: make("local", "localhost", server("DNS:localhost, IP:127.0.0.1, IP:::1"), "ca"),
      second: make("second", "localhost", server("DNS:localhost"), "second-ca"),
      farName: make("far-name", "qdrant.test", server("DNS:qdrant.test"), "ca"),
      farAddress: make("far-address", "far-address", server("IP:10.0.0.5"), "ca"),
      guarded: make("guarded", "guard.test", server("DNS:guard.test"), "ca"),
      client: make("client", "reader", ["basicConstraints = CA:FALSE", "extendedKeyUsage = clientAuth"], "ca"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An answer of `bytes` bytes of the letter a, written in 1 MiB pieces as the socket drains. */
export function streamingAnswer(bytes: number): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const piece = Buffer.alloc(1024 * 1024, 0x61);
    let left = bytes;
    const write = (): void => {
      while (left > 0) {
        const next = left >= piece.length ? piece : piece.subarray(0, left);
        left -= next.length;
        if (!response.write(next)) {
          response.once("drain", write);
          return;
        }
      }
      response.end();
    };
    write();
  };
}

/** A gzip stream of `bytes` zero bytes, compressed as a stream so the zeros are never held whole: about 1 MB per GiB. */
export async function gzipOfZeros(bytes: number): Promise<Buffer> {
  const gzip = createGzip({ level: constants.Z_BEST_COMPRESSION });
  const parts: Buffer[] = [];
  gzip.on("data", (part: Buffer) => parts.push(part));
  const ended = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  const zeros = Buffer.alloc(16 * 1024 * 1024);
  for (let left = bytes; left > 0; left -= zeros.length) {
    const piece = left >= zeros.length ? zeros : zeros.subarray(0, left);
    if (!gzip.write(piece)) {
      // oxlint-disable-next-line no-await-in-loop -- backpressure: one 16 MiB piece in the compressor at a time.
      await new Promise((resolve) => gzip.once("drain", resolve));
    }
  }
  gzip.end();
  await ended;
  return Buffer.concat(parts);
}

/** A TCP listener that counts what it accepts and never answers or closes it: a server that holds every request. */
export function silentListener(): Promise<Listener> {
  return observe(
    createTcpServer(() => {}),
    [],
    "127.0.0.1",
  );
}

/** A TCP listener that counts what it accepts and closes it at once: the proxy every proxy variable names. */
export function countingListener(): Promise<Listener> {
  return observe(
    createTcpServer((socket) => socket.destroy()),
    [],
    "127.0.0.1",
  );
}
