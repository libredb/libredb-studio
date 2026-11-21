/**
 * The Oracle provider over the real oracledb Thin transport, against in-process peers.
 *
 * tests/integration/db/oracle-provider.test.ts replaces `oracledb` with a mock, so the driver's own
 * socket handling (`oracledb/lib/thin/sqlnet/ntTcp.js`) is never in its path. Here nothing is mocked:
 * the real `OracleProvider` builds a real Thin pool, and the far side is a plain TCP server that
 * answers the way a refusing HTTPS proxy or a broken TNS listener does.
 *
 * Three transport failures are pinned, each as a named error on the call that dialled, with the socket
 * closed by the client:
 *
 *  - A descriptor that names `HTTPS_PROXY` makes the driver send an HTTP CONNECT. A proxy that answers
 *    anything but 200 fails the connect with NJS-504 and the status, and the socket the proxy answered
 *    on is destroyed then, not left open with no error listener (`patches/oracledb@26.0.0.patch`).
 *  - A TNS packet header whose length field is below the 8-byte header size fails the connect with
 *    NJS-500 naming the invalid length, and the event loop keeps running (oracledb 26.0.0).
 *  - The same header arriving after the client has closed the session itself is refused on the socket
 *    that read it, so the connect still fails with its own error (the same patch).
 *
 * The proxy cases run in this process. The two packet header cases never do: oracledb 6.10.0 answered that header by
 * looping forever in its socket `data` handler while allocating, and an in-process run of them under bun reached
 * 28 GB in 18 seconds. They run in oracle-thin-transport-harness.ts instead, bundled for Node with the installed
 * driver left external, one Node child per case with `--max-old-space-size=256` and a hard timeout, so a driver that
 * loops again fails the case within seconds at the child's heap limit.
 *
 * docs/providers/oracle.md section 4.5 states all three as a user sees them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionError } from "@/lib/db/errors";
import { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { DatabaseConnection } from "@/lib/types";
import type { HarnessCase, HarnessReport } from "./oracle-thin-transport-harness";

/** What the peer saw of one client connection. */
interface PeerConnection {
  socket: net.Socket;
  /** Set when the client closes its side (FIN, close or reset). */
  clientClosed: boolean;
  /** Settles when the client answers with a reset, which only a destroyed socket does. */
  resetByClient: Promise<void>;
}

interface Peer {
  port: number;
  connections: PeerConnection[];
  server: net.Server;
}

const peers: Peer[] = [];
const providers: OracleProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.disconnect()));
  await Promise.all(
    peers.splice(0).map((peer) => {
      for (const { socket } of peer.connections) {
        socket.destroy();
      }
      return new Promise<void>((resolve) => peer.server.close(() => resolve()));
    }),
  );
});

/**
 * A TCP peer that answers the client's first bytes once.
 * With `probeAfterFin`, the peer keeps its own side open after the client's FIN and writes to the
 * client: a destroyed client socket answers with a reset, one that was only ended reads the bytes.
 */
async function startPeer(answer: (socket: net.Socket, first: Buffer) => void, probeAfterFin = false) {
  const connections: PeerConnection[] = [];
  const server = net.createServer({ allowHalfOpen: probeAfterFin }, (socket) => {
    let markReset!: () => void;
    const connection: PeerConnection = {
      socket,
      clientClosed: false,
      resetByClient: new Promise<void>((resolve) => {
        markReset = resolve;
      }),
    };
    const closed = () => {
      connection.clientClosed = true;
    };
    socket.on("end", () => {
      closed();
      if (probeAfterFin) {
        socket.write("are you still reading?");
      }
    });
    socket.on("close", closed);
    // A reset from the client is the client closing, too; the peer must not throw on it. Node reports
    // the reset as ECONNRESET, bun as EPIPE on the read.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      closed();
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        markReset();
      }
    });
    connections.push(connection);
    // The peer reads everything the client sends, because a socket that is not read never reports the
    // client's FIN. The client sends its HTTP CONNECT head in one write, and only that one is answered.
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (!answered) {
        answered = true;
        answer(socket, chunk);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const peer: Peer = { port: (server.address() as net.AddressInfo).port, connections, server };
  peers.push(peer);
  return peer;
}

function oracleConnection(fields: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: "oracle-thin-transport",
    name: "oracle thin transport",
    type: "oracle",
    user: "scott",
    password: "not-a-secret",
    createdAt: new Date(0),
    ...fields,
  } as DatabaseConnection;
}

/** Connects and returns the error it failed with; a connect that succeeds fails the test. */
async function connectError(config: DatabaseConnection): Promise<Error> {
  const provider = new OracleProvider(config, { queryTimeout: 5000 });
  providers.push(provider);
  try {
    await provider.connect();
  } catch (error) {
    return error as Error;
  }
  throw new Error("connect() resolved against a peer that is not an Oracle listener");
}

/**
 * How the client left a connection to a `probeAfterFin` peer, after up to `ms`: "reset" when it
 * destroyed its socket, "half-open" when it only ended its side and still reads, "open" with no FIN.
 */
async function clientExitWithin(connection: PeerConnection, ms: number): Promise<"reset" | "half-open" | "open"> {
  const reset = await Promise.race([
    connection.resetByClient.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
  if (reset) {
    return "reset";
  }
  return connection.clientClosed ? "half-open" : "open";
}

describe("Oracle Thin transport: a proxy that refuses the CONNECT", () => {
  test.each([
    ["403 Forbidden", "403"],
    ["407 Proxy Authentication Required", "407"],
  ])(
    "a %s answer fails the connect with NJS-504 and the client destroys the proxy socket",
    async (statusLine, status) => {
      // The answer keeps the connection open, as a proxy that allows keep-alive does: whether the
      // socket is closed is then the client's doing alone. The proxy also keeps its side open after
      // the client's FIN, so a socket the client only ended, and could still be reset later, shows.
      const proxy = await startPeer((socket, first) => {
        expect(first.toString("latin1")).toStartWith("CONNECT 127.0.0.2:2484 HTTP/1.1");
        socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\n\r\n`);
      }, true);
      const descriptor =
        `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=127.0.0.2)(PORT=2484)` +
        `(HTTPS_PROXY=127.0.0.1)(HTTPS_PROXY_PORT=${proxy.port}))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1)))`;

      const error = await connectError(oracleConnection({ connectionString: descriptor }));

      expect(error).toBeInstanceOf(ConnectionError);
      expect(error.message).toContain("Failed to connect to Oracle: NJS-504:");
      expect(error.message).toContain(`web proxy at host 127.0.0.1 port ${proxy.port} failed`);
      expect(error.message).toEndWith(`\n${status}`);
      expect(proxy.connections).toHaveLength(1);
      // Destroyed by the time the call has answered: the bytes the proxy writes after the client's
      // FIN are answered with a reset, not read.
      expect(await clientExitWithin(proxy.connections[0], 1000)).toBe("reset");
    },
  );
});

const HARNESS = join(import.meta.dir, "oracle-thin-transport-harness.ts");
/**
 * Where the child finds the packages the bundle leaves external, the installed and patched driver among them.
 * The bundle is CommonJS in a temporary directory, so Node resolves them through NODE_PATH.
 */
const NODE_MODULES = join(import.meta.dir, "..", "..", "..", "node_modules");
/** Kills a child that neither finishes nor reaches its heap limit; a case that passes ends in about a second. */
const CHILD_TIMEOUT_MS = 20_000;
const CHILD_HEAP_MB = 256;

let bundleDir = "";

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "oracle-thin-transport-"));
  const build = await Bun.build({
    entrypoints: [HARNESS],
    target: "node",
    format: "cjs",
    packages: "external",
    outdir: bundleDir,
    naming: "[name].cjs",
  });
  if (!build.success) {
    throw new Error(`Bun.build could not bundle the harness: ${build.logs.join("\n")}`);
  }
}, 60_000);

afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

/** The last `chars` characters of a child's stderr, for a failure message. */
function tail(text: string, chars = 2000): string {
  return text.length > chars ? `...${text.slice(-chars)}` : text;
}

/**
 * Runs one harness case in a Node child with its own heap limit and a hard timeout, and returns its report.
 * A child that times out, exits other than 0 or prints no report fails the test with what happened.
 */
function runInChild(name: HarnessCase): HarnessReport {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("No node on PATH: the packet header cases run in a Node child");
  }
  const child = spawnSync(
    node,
    [`--max-old-space-size=${CHILD_HEAP_MB}`, join(bundleDir, "oracle-thin-transport-harness.cjs"), name],
    {
      cwd: bundleDir,
      env: { ...process.env, NODE_PATH: NODE_MODULES },
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
    },
  );
  const stderr = tail(child.stderr ?? "");
  if (child.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(`The "${name}" child timed out after ${CHILD_TIMEOUT_MS} ms and was killed. stderr:\n${stderr}`);
  }
  if (child.error) {
    throw new Error(`The "${name}" child could not run: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `The "${name}" child exited with code ${child.status} and signal ${child.signal} ` +
        `(heap limit ${CHILD_HEAP_MB} MB). stderr:\n${stderr}`,
    );
  }
  const lines = child.stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  if (last === "") {
    throw new Error(`The "${name}" child exited 0 but printed no report. stderr:\n${stderr}`);
  }
  return JSON.parse(last) as HarnessReport;
}

describe("Oracle Thin transport: a TNS packet header shorter than the header itself", () => {
  test.each([
    ["0, in answer to CONNECT", 0, "length 0, in answer to CONNECT"],
    ["7, in answer to CONNECT", 7, "length 7, in answer to CONNECT"],
    ["0, before the client has spoken", 0, "length 0, before the client has spoken"],
  ] as const)(
    "a length of %s fails the connect with a named error while the event loop keeps running",
    (_label, length, name) => {
      const report = runInChild(name);

      expect(report.case).toBe(name);
      expect(report.error?.name).toBe("ConnectionError");
      expect(report.error?.message).toContain("Failed to connect to Oracle: NJS-500:");
      expect(report.error?.message).toContain(`Invalid packet length: ${length} (must be at least 8)`);
      expect(report.worstGapMs).toBeLessThan(1000);
      expect(report.peerConnections).toBe(1);
      expect(report.peerSaw).toBe("closed");
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});

describe("Oracle Thin transport: a packet header the driver cannot read, after the client closed the session", () => {
  test(
    "a header of length 0 that answers the client's EOF leaves the connect failing with NJS-138",
    () => {
      const report = runInChild("length 0, answering the client's EOF after NJS-138");

      expect(report.case).toBe("length 0, answering the client's EOF after NJS-138");
      expect(report.error?.name).toBe("DatabaseConfigError");
      expect(report.error?.message).toContain("NJS-138");
      expect(report.peerConnections).toBe(1);
      expect(report.peerSaw).toBe("closed");
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
