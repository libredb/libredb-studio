/**
 * The Oracle provider over the real oracledb Thin transport, against in-process peers.
 *
 * tests/integration/db/oracle-provider.test.ts replaces `oracledb` with a mock, so the driver's own
 * socket handling (`oracledb/lib/thin/sqlnet/ntTcp.js`) is never in its path. Here nothing is mocked:
 * the real `OracleProvider` builds a real Thin pool, and the far side is a plain TCP server that
 * answers the way a broken TNS listener does.
 *
 * A TNS packet header whose length field is below the 8-byte header size fails the connect with
 * NJS-500 naming the invalid length, the event loop keeps running, and the client closes the socket
 * (oracledb 26.0.0).
 *
 * docs/providers/oracle.md section 4.5 states it as a user sees it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { ConnectionError } from "@/lib/db/errors";
import { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { DatabaseConnection } from "@/lib/types";

/** What the peer saw of one client connection. */
interface PeerConnection {
  socket: net.Socket;
  /** Settles when the client closes its side (FIN or close). */
  closedByClient: Promise<void>;
  clientClosed: boolean;
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
 * `onAccept` answers before the client has said anything.
 */
async function startPeer(answer: (socket: net.Socket, first: Buffer) => void, onAccept?: (socket: net.Socket) => void) {
  const connections: PeerConnection[] = [];
  const server = net.createServer((socket) => {
    let markClosed!: () => void;
    const connection: PeerConnection = {
      socket,
      clientClosed: false,
      closedByClient: new Promise<void>((resolve) => {
        markClosed = resolve;
      }),
    };
    const closed = () => {
      connection.clientClosed = true;
      markClosed();
    };
    socket.on("end", closed);
    socket.on("close", closed);
    // A reset from the client is the client closing, too; the peer must not throw on it.
    socket.on("error", closed);
    connections.push(connection);
    // The peer reads everything the client sends, because a socket that is not read never reports the
    // client's FIN. The client sends its opening request, the TNS CONNECT packet, in one write, and only
    // that one is answered.
    let answered = false;
    if (onAccept) {
      answered = true;
      onAccept(socket);
    }
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

/** Settles with "closed" once the client has closed the connection, or "open" after `ms`. */
function closedWithin(connection: PeerConnection, ms: number): Promise<"closed" | "open"> {
  return Promise.race([
    connection.closedByClient.then(() => "closed" as const),
    new Promise<"open">((resolve) => setTimeout(() => resolve("open"), ms)),
  ]);
}

describe("Oracle Thin transport: a TNS packet header shorter than the header itself", () => {
  /** An 8-byte TNS header whose 16-bit length field is `length`. */
  const header = (length: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt16BE(length, 0);
    return bytes;
  };

  test.each([
    ["0, in answer to CONNECT", 0, false],
    ["7, in answer to CONNECT", 7, false],
    ["0, before the client has spoken", 0, true],
  ])(
    "a length of %s fails the connect with a named error while the event loop keeps running",
    async (_label, length, onAccept) => {
      const listener = await startPeer(
        (socket) => socket.write(header(length)),
        onAccept ? (socket) => socket.write(header(length)) : undefined,
      );

      // A heartbeat that measures the longest stretch the event loop went without running a timer.
      let last = Date.now();
      let worstGap = 0;
      const heartbeat = setInterval(() => {
        const now = Date.now();
        worstGap = Math.max(worstGap, now - last);
        last = now;
      }, 20);
      let error: Error;
      try {
        error = await connectError(
          oracleConnection({ host: "127.0.0.1", port: listener.port, serviceName: "FREEPDB1" }),
        );
      } finally {
        clearInterval(heartbeat);
      }

      expect(error).toBeInstanceOf(ConnectionError);
      expect(error.message).toContain("Failed to connect to Oracle: NJS-500:");
      expect(error.message).toContain(`Invalid packet length: ${length} (must be at least 8)`);
      expect(worstGap).toBeLessThan(1000);
      expect(listener.connections).toHaveLength(1);
      expect(await closedWithin(listener.connections[0], 1000)).toBe("closed");
    },
  );
});
