/**
 * A Kubernetes-discovered PostgreSQL connection names its server by a fully qualified name with a trailing dot
 * (src/lib/seed/kubernetes-discovery-contract.ts), so the pod's DNS search path never applies.
 *
 * These tests take the PostgreSQL provider's own pool configuration for such a connection and open a session with it
 * through the real `pg` driver, against a local server that answers the TLS request and the startup message the way
 * PostgreSQL does, reached as `localhost.`: the trailing dot goes through the resolver, the TLS server name and, in a
 * verifying mode, the certificate check, and the session still opens.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { mapKubernetesDatabase } from "@/lib/seed/kubernetes-discovery-contract";
import type { DatabaseConnection } from "@/lib/types";
import { goldenDatabases } from "../../helpers/kubernetes-discovery-fixture";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";

const TLS = loadTlsFixtures();
/** A name the resolver takes as written, as it takes a discovered host; the fixture certificate is for localhost. */
const LOCALHOST_FQDN = "localhost.";
/** The request code of PostgreSQL's SSLRequest message. */
const SSL_REQUEST_CODE = 80877103;
/** AuthenticationOk, then ReadyForQuery with the idle status. */
const AUTHENTICATED_AND_READY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

// The hosts below are those of the default cluster domain.
delete process.env.KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let server: Server | null = null;
/** Every server-side socket, destroyed after each test: `close()` waits for open ones. */
let accepted: Socket[] = [];

afterEach(async () => {
  for (const socket of accepted) socket.destroy();
  accepted = [];
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** The first golden database as Studio lists it. */
function discoveredConnection(): DatabaseConnection {
  const mapped = mapKubernetesDatabase(goldenDatabases()[0]);
  if (!mapped.ok) throw new Error(mapped.reason);
  const { id, name, type, host, port, user, password, database, ssl } = mapped.connection;
  if (ssl?.mode === undefined) throw new Error("the discovered connection names no TLS mode");
  return {
    id,
    name,
    type,
    host,
    port,
    user,
    password,
    database,
    ssl: { ...ssl, mode: ssl.mode },
    createdAt: new Date(),
  };
}

/** The configuration the provider hands `new Pool(...)` when it connects; `buildPoolConfig` is private. */
function poolConfigOf(connection: DatabaseConnection): PoolConfig {
  const provider = new PostgresProvider(connection);
  return (provider as unknown as { buildPoolConfig(): PoolConfig }).buildPoolConfig();
}

/**
 * A server that answers a client asking for TLS as PostgreSQL does: `S`, the TLS handshake, then AuthenticationOk and
 * ReadyForQuery for the startup message. `servername` is the name the client sent (SNI).
 */
async function listenLikePostgres() {
  const seen = { sslRequest: false, startup: false, servername: undefined as string | false | undefined };
  server = createServer((socket) => {
    accepted.push(socket);
    socket.once("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      seen.sslRequest = bytes.length === 8 && bytes.readInt32BE(4) === SSL_REQUEST_CODE;
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, key: TLS.server.key, cert: TLS.server.cert });
      secure.on("secure", () => {
        seen.servername = (secure as TLSSocket & { servername?: string | false }).servername;
      });
      secure.once("data", () => {
        seen.startup = true;
        secure.write(AUTHENTICATED_AND_READY);
      });
      secure.on("error", () => socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, seen };
}

/** Opens one session with `config` and closes the pool again. */
async function openSession(config: PoolConfig): Promise<void> {
  const pool = new Pool(config);
  try {
    const client = await pool.connect();
    client.release();
  } finally {
    await pool.end();
  }
}

describe("a Kubernetes-discovered connection's fully qualified host", () => {
  test("reaches pg as written, with TLS on and the certificate unchecked, as ssl mode require asks", () => {
    const config = poolConfigOf(discoveredConnection());
    expect(config.host).toBe("orders-rw.team-a.svc.cluster.local.");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  test("opens a TLS session with that configuration, naming the host as the TLS server name", async () => {
    const { port, seen } = await listenLikePostgres();
    await openSession({ ...poolConfigOf(discoveredConnection()), host: LOCALHOST_FQDN, port });
    expect(seen).toMatchObject({ sslRequest: true, startup: true });
    // With or without its trailing dot: a server that does not route on the name ignores it.
    expect(String(seen.servername).replace(/\.$/, "")).toBe("localhost");
  });

  test("passes a verifying mode's certificate check, which compares the name without its trailing dot", async () => {
    const { port, seen } = await listenLikePostgres();
    const connection: DatabaseConnection = {
      ...discoveredConnection(),
      host: LOCALHOST_FQDN,
      port,
      ssl: { mode: "verify-full", caCert: TLS.ca },
    };
    await openSession(poolConfigOf(connection));
    expect(seen).toMatchObject({ sslRequest: true, startup: true });
  });
});
