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
 * docs/providers/oracle.md section 4.5 states both as a user sees them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { DatabaseConnection } from "@/lib/types";

/** What the peer saw of one client connection. */
interface PeerConnection {
  socket: net.Socket;
  /** Settles when the client closes its side (FIN or close). */
  closedByClient: Promise<void>;
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
 * `onAccept` answers before the client has said anything.
 * With `probeAfterFin`, the peer keeps its own side open after the client's FIN and writes to the
 * client: a destroyed client socket answers with a reset, one that was only ended reads the bytes.
 */
async function startPeer(
  answer: (socket: net.Socket, first: Buffer) => void,
  onAccept?: (socket: net.Socket) => void,
  probeAfterFin = false,
) {
  const connections: PeerConnection[] = [];
  const server = net.createServer({ allowHalfOpen: probeAfterFin }, (socket) => {
    let markClosed!: () => void;
    let markReset!: () => void;
    const connection: PeerConnection = {
      socket,
      clientClosed: false,
      closedByClient: new Promise<void>((resolve) => {
        markClosed = resolve;
      }),
      resetByClient: new Promise<void>((resolve) => {
        markReset = resolve;
      }),
    };
    const closed = () => {
      connection.clientClosed = true;
      markClosed();
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
    // client's FIN. Both clients send their opening request in one write (the HTTP CONNECT head, or the
    // TNS CONNECT packet), and only that one is answered.
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

/** Settles with "closed" once the client has closed the connection, or "open" after `ms`. */
function closedWithin(connection: PeerConnection, ms: number): Promise<"closed" | "open"> {
  return Promise.race([
    connection.closedByClient.then(() => "closed" as const),
    new Promise<"open">((resolve) => setTimeout(() => resolve("open"), ms)),
  ]);
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
      const proxy = await startPeer(
        (socket, first) => {
          expect(first.toString("latin1")).toStartWith("CONNECT 127.0.0.2:2484 HTTP/1.1");
          socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\n\r\n`);
        },
        undefined,
        true,
      );
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

describe("Oracle Thin transport: a packet header the driver cannot read, after the client closed the session", () => {
  /**
   * A TNS ACCEPT packet of protocol version 314, one below the lowest the Thin driver accepts, with
   * native network services off, so the session comes up and the client then refuses it with NJS-138
   * and closes it gracefully: an EOF data packet, then its FIN.
   */
  const acceptVersion314 = () => {
    const packet = Buffer.alloc(32);
    packet.writeUInt16BE(32, 0); // packet length
    packet[4] = 2; // ACCEPT
    packet.writeUInt16BE(314, 8); // protocol version
    packet.writeUInt16BE(8192, 12); // SDU
    packet.writeUInt16BE(65535, 14); // TDU
    packet.writeUInt16BE(0x0100, 16);
    packet.writeUInt16BE(32, 20); // offset of the (empty) connect data
    packet[23] = 0x08; // flags: no native network services
    return packet;
  };

  test("a header of length 0 that answers the client's EOF leaves the connect failing with NJS-138", async () => {
    const listener = await startPeer((socket, first) => {
      socket.write(acceptVersion314());
      // The CONNECT packet may be followed by its connect data in a DATA packet; read packets until the
      // client's EOF (a DATA packet whose data flags carry 0x40) and answer that with 8 zero bytes.
      let pending = first.subarray(Math.min(first.readUInt16BE(0), first.length));
      const read = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 10 && pending.readUInt16BE(0) <= pending.length) {
          const length = pending.readUInt16BE(0);
          const isEof = pending[4] === 6 && (pending.readUInt16BE(8) & 0x40) !== 0;
          pending = pending.subarray(length);
          if (isEof) {
            socket.write(Buffer.alloc(8));
          }
        }
      };
      read(Buffer.alloc(0));
      socket.on("data", read);
    });

    const error = await connectError(
      oracleConnection({ host: "127.0.0.1", port: listener.port, serviceName: "FREEPDB1" }),
    );

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain("NJS-138");
    expect(listener.connections).toHaveLength(1);
    expect(await closedWithin(listener.connections[0], 1000)).toBe("closed");
  });
});
