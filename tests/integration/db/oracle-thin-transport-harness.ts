/**
 * Child-process harness for the packet header cases of oracle-thin-transport.test.ts.
 *
 * A TNS packet header whose length field is below the 8-byte header size is the input that made the Thin driver of
 * oracledb 6.10.0 loop forever in its socket `data` handler, pushing a packet object on every turn: an in-process run
 * of these cases under bun reached 28 GB in 18 seconds. So the test never runs them in its own process. It bundles this
 * file with `bun build --target=node --packages=external` as CommonJS, so the installed and patched `oracledb` is what
 * loads (the child finds it through NODE_PATH), and runs one case per Node child with `--max-old-space-size=256` and
 * a hard timeout: a driver that loops again ends the child at its heap limit within seconds, and the test fails
 * naming that exit.
 *
 * The case to run is the first argument. The child runs the real `OracleProvider` against a TCP peer of its own,
 * and prints one JSON line on stdout: the error the connect failed with, the longest stretch the event loop went
 * without running a timer, and whether the peer saw the client close its connection within 1 s.
 */
import net from "node:net";
import { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The cases this harness runs, by the name the test passes as the first argument.
 * The test imports only the types of this file: importing a value would run `main()` in the bun test process.
 */
const HARNESS_CASES = [
  "length 0, in answer to CONNECT",
  "length 7, in answer to CONNECT",
  "length 0, before the client has spoken",
  "length 0, answering the client's EOF after NJS-138",
] as const;

export type HarnessCase = (typeof HARNESS_CASES)[number];

export interface HarnessReport {
  readonly case: HarnessCase;
  /** The error `connect()` failed with, or null when it resolved. */
  readonly error: { readonly name: string; readonly message: string } | null;
  /** The longest gap, in ms, between two runs of a 20 ms interval timer while the connect was in flight. */
  readonly worstGapMs: number;
  /** How many connections the peer accepted. */
  readonly peerConnections: number;
  /** Whether the client closed the peer's first connection within 1 s of the connect answering. */
  readonly peerSaw: "closed" | "open";
}

/** What the peer saw of one client connection. */
interface PeerConnection {
  socket: net.Socket;
  /** Settles when the client closes its side (FIN, close or reset). */
  closedByClient: Promise<void>;
}

/**
 * A TCP peer that answers the client's first bytes once.
 * `onAccept` answers before the client has said anything.
 */
async function startPeer(
  answer: (socket: net.Socket, first: Buffer) => void,
  onAccept?: (socket: net.Socket) => void,
): Promise<{ port: number; connections: PeerConnection[]; server: net.Server }> {
  const connections: PeerConnection[] = [];
  const server = net.createServer((socket) => {
    let markClosed!: () => void;
    const closedByClient = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    socket.on("end", markClosed);
    socket.on("close", markClosed);
    // A reset from the client is the client closing, too; the peer must not throw on it.
    socket.on("error", markClosed);
    connections.push({ socket, closedByClient });
    // The peer reads everything the client sends, because a socket that is not read never reports the client's FIN.
    // The client sends its TNS CONNECT packet in one write, and only that one is answered.
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
  return { port: (server.address() as net.AddressInfo).port, connections, server };
}

/** An 8-byte TNS header whose 16-bit length field is `length`. */
function header(length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16BE(length, 0);
  return bytes;
}

/**
 * A TNS ACCEPT packet of protocol version 314, one below the lowest the Thin driver accepts, with native network
 * services off, so the session comes up and the client then refuses it with NJS-138 and closes it gracefully: an EOF
 * data packet, then its FIN.
 */
function acceptVersion314(): Buffer {
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
}

/** Answers the CONNECT with the version 314 ACCEPT, then the client's EOF data packet with a header of length 0. */
function answerEofWithShortHeader(socket: net.Socket, first: Buffer): void {
  socket.write(acceptVersion314());
  // The CONNECT packet may be followed by its connect data in a DATA packet; read packets until the client's EOF
  // (a DATA packet whose data flags carry 0x40) and answer that with 8 zero bytes.
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
}

function startCasePeer(name: HarnessCase) {
  switch (name) {
    case "length 0, in answer to CONNECT":
      return startPeer((socket) => socket.write(header(0)));
    case "length 7, in answer to CONNECT":
      return startPeer((socket) => socket.write(header(7)));
    case "length 0, before the client has spoken":
      return startPeer(
        (socket) => socket.write(header(0)),
        (socket) => socket.write(header(0)),
      );
    case "length 0, answering the client's EOF after NJS-138":
      return startPeer(answerEofWithShortHeader);
  }
}

function closedWithin(connection: PeerConnection, ms: number): Promise<"closed" | "open"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    connection.closedByClient.then(() => "closed" as const),
    new Promise<"open">((resolve) => {
      timer = setTimeout(() => resolve("open"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runCase(name: HarnessCase): Promise<HarnessReport> {
  const peer = await startCasePeer(name);
  const config = {
    id: "oracle-thin-transport",
    name: "oracle thin transport",
    type: "oracle",
    user: "scott",
    password: "not-a-secret",
    host: "127.0.0.1",
    port: peer.port,
    serviceName: "FREEPDB1",
    createdAt: new Date(0),
  } as DatabaseConnection;
  const provider = new OracleProvider(config, { queryTimeout: 5000 });

  let last = Date.now();
  let worstGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    worstGapMs = Math.max(worstGapMs, now - last);
    last = now;
  }, 20);
  let error: HarnessReport["error"] = null;
  try {
    await provider.connect();
  } catch (caught) {
    error =
      caught instanceof Error ? { name: caught.name, message: caught.message } : { name: "", message: String(caught) };
  } finally {
    clearInterval(heartbeat);
  }

  const first = peer.connections[0];
  const peerSaw = first === undefined ? "open" : await closedWithin(first, 1000);
  await provider.disconnect();
  for (const { socket } of peer.connections) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => peer.server.close(() => resolve()));
  return { case: name, error, worstGapMs, peerConnections: peer.connections.length, peerSaw };
}

function isHarnessCase(value: string | undefined): value is HarnessCase {
  return (HARNESS_CASES as readonly (string | undefined)[]).includes(value);
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!isHarnessCase(name)) {
    throw new Error(`Unknown case "${name}"; expected one of: ${HARNESS_CASES.join(" | ")}`);
  }
  const report = await runCase(name);
  // On a pipe, stdout can be asynchronous (Windows), so the process exits once the line is written.
  process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
