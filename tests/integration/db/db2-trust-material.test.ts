/**
 * A private CA reaches Db2 through the trust material Studio hands it (FND-2 slice 4), measured with the real driver.
 *
 * db2-node verifies with rustls against the operating system's trust store and never reads NODE_EXTRA_CA_CERTS, so
 * the operator's CA bundle reaches a Db2 connection only as the certificates core reads from that file and the
 * provider factory hands the provider; the provider writes them to its private CA file in the modes that verify
 * against the system trust store. Each case builds the provider through `createDatabaseProvider`, as Test Connection
 * does, and dials a `node:tls` server on 127.0.0.1 whose certificate only a CA made at test time signs
 * (`makeCertificates()`), so no platform's store can hold it. No Db2 speaks on the server: it closes the socket once
 * the handshake completes, so a reached server is read from its own `secureConnection` signal, and a refusal from the
 * settled rejection and the server's counts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { Db2Provider } from "@/lib/db/providers/sql/db2/index";
import type { DatabaseConnection } from "@/lib/db/types";
import { TRUST_MATERIAL_MISSING } from "@/lib/db/utils/require-trust-material";
import { logger } from "@/lib/logger";
import type { SSLConfig } from "@/lib/types";
import { setExtraCaCerts, withExtraCaCerts } from "../../helpers/extra-ca-certs";
import { makeCertificates, type Pair, type TransportCertificates } from "../../helpers/node-transport-fixtures";

/** What rustls answers for a certificate whose issuer it does not trust: with a system store, or with none at all. */
const UNTRUSTED_ISSUER = /UnknownIssuer|no root certificates are available/;

interface Fixture {
  readonly port: number;
  /** TCP connections the server accepted. */
  accepted(): number;
  /** TLS handshakes the client completed. */
  handshakes(): number;
  /** Settles when the first handshake completes. */
  readonly reached: Promise<void>;
  /**
   * Settles when the server accepts its first TCP connection. A client that refuses before the server sends a byte (no
   * system store at all) can report its refusal before the server's 'connection' event runs, so a test that counts
   * accepted connections after a refusal waits on this first.
   */
  readonly connected: Promise<void>;
}

const servers: Server[] = [];
const sockets: Socket[] = [];

/** A TLS server presenting `pair`, which closes every socket once its handshake completes. */
async function tlsFixture(pair: Pair): Promise<Fixture> {
  let accepted = 0;
  let handshakes = 0;
  let reach: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let connect: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    connect = resolve;
  });
  const server = createServer({ key: pair.key, cert: pair.cert }, (socket: TLSSocket) => {
    handshakes += 1;
    reach();
    socket.destroy();
  });
  server.on("connection", (socket: Socket) => {
    accepted += 1;
    sockets.push(socket);
    connect();
  });
  // A client that refuses the certificate aborts the handshake; the refusal is read from the client's error.
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    accepted: () => accepted,
    handshakes: () => handshakes,
    reached,
    connected,
  };
}

function db2Connection(port: number, ssl: SSLConfig): DatabaseConnection {
  return {
    id: "db2-trust-material",
    name: "db2 trust material",
    type: "db2",
    host: "127.0.0.1",
    port,
    user: "probe",
    password: crypto.randomUUID(),
    database: "TESTDB",
    createdAt: new Date(0),
    ssl,
  };
}

/** The rejection of `connect()`, settled with a plain await before anything is asserted. */
async function connectFailure(provider: { connect(): Promise<void> }): Promise<Error> {
  const outcome = await provider.connect().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected connect() to fail: no Db2 speaks on the fixture");
  return outcome;
}

const original = process.env.NODE_EXTRA_CA_CERTS;
let certificates: TransportCertificates;
let dir: string;
let bundle: string;
let info: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;

beforeAll(() => {
  certificates = makeCertificates();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libredb-db2-trust-"));
  bundle = join(dir, "ca-bundle.crt");
  writeFileSync(bundle, certificates.ca);
  info = spyOn(logger, "info").mockImplementation(() => {});
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  info.mockRestore();
  log.mockRestore();
  setExtraCaCerts(original);
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe("a private CA reaches Db2 through the trust material Studio hands it (FND-2 slice 4)", () => {
  test("Verify (system trust) reaches a server whose certificate only the CA in NODE_EXTRA_CA_CERTS signs", async () => {
    const server = await tlsFixture(certificates.local);
    setExtraCaCerts(bundle);
    const provider = await createDatabaseProvider(db2Connection(server.port, { mode: "verify-system" }));
    const failure = await connectFailure(provider);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).not.toMatch(UNTRUSTED_ISSUER);
    expect(failure.message).not.toContain("not valid for name");
    // The signal fired before the fixture closed the socket, so before the client's error settled above.
    await server.reached;
    expect(server.handshakes()).toBe(1);
  });

  test("Verify full without a CA of its own reaches it too", async () => {
    const server = await tlsFixture(certificates.local);
    setExtraCaCerts(bundle);
    const provider = await createDatabaseProvider(db2Connection(server.port, { mode: "verify-full" }));
    const failure = await connectFailure(provider);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).not.toMatch(UNTRUSTED_ISSUER);
    await server.reached;
    expect(server.handshakes()).toBe(1);
  });

  test("with NODE_EXTRA_CA_CERTS unset the same connection is refused, and no handshake completes", async () => {
    const server = await tlsFixture(certificates.local);
    const failure = await withExtraCaCerts(undefined, async () => {
      const provider = await createDatabaseProvider(db2Connection(server.port, { mode: "verify-system" }));
      return connectFailure(provider);
    });

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).toMatch(UNTRUSTED_ISSUER);
    await server.connected;
    expect(server.accepted()).toBe(1);
    expect(server.handshakes()).toBe(0);
  });

  test("a connection with its own CA is handed none of the bundle", async () => {
    const server = await tlsFixture(certificates.local);
    setExtraCaCerts(bundle);
    const provider = await createDatabaseProvider(
      db2Connection(server.port, { mode: "verify-full", caCert: certificates.rogueCa }),
    );
    const failure = await connectFailure(provider);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).toMatch(UNTRUSTED_ISSUER);
    expect(server.handshakes()).toBe(0);
  });

  test("the handed certificates do not loosen the name check", async () => {
    const server = await tlsFixture(certificates.farName);
    setExtraCaCerts(bundle);
    const provider = await createDatabaseProvider(db2Connection(server.port, { mode: "verify-system" }));
    const failure = await connectFailure(provider);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).toContain("not valid for name");
    expect(server.handshakes()).toBe(0);
  });

  test("a Db2 provider built without the factory's trust material refuses by name, and the server accepts no connection", async () => {
    const server = await tlsFixture(certificates.local);
    setExtraCaCerts(bundle);
    const provider = new Db2Provider(db2Connection(server.port, { mode: "verify-system" }));
    const failure = await connectFailure(provider);

    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect(failure.message).toBe(TRUST_MATERIAL_MISSING);
    expect(server.accepted()).toBe(0);
  });
});
