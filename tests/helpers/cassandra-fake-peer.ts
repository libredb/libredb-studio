/**
 * A fake Apache Cassandra node on 127.0.0.1 that speaks just enough of the native protocol (v4) for
 * `cassandra-driver` to connect, and that sends one malformed frame where a case asks for it.
 * Nothing under src/ imports this file.
 *
 * The healthy part answers what the driver and the provider send on connect: a STARTUP at a version above v4 is
 * refused the way a v4-only node refuses it, so the driver negotiates down; OPTIONS is answered with no options,
 * STARTUP and REGISTER are READY; a query
 * that reads `system.local` gets one row of text columns; every other query gets an empty set of rows.
 *
 * Each case replaces one answer with a frame the driver cannot parse:
 * - `truncated-error`: the answer to the first STARTUP is an ERROR frame whose 2-byte body cannot hold its error code.
 * - `truncated-auth`: the answer to the first STARTUP is an AUTHENTICATE frame whose string length runs past the body.
 * - `header-mismatch`: the answer to the first STARTUP is a v1 READY header (8 bytes) followed by a v4 header cut
 *   to 8 bytes, so the driver, which sizes every later header from the first byte it read, reads past it.
 * - `malformed-answer`: the node is healthy until a query whose text holds {@link MALFORMED_MARKER}, which gets the
 *   `truncated-error` frame; the queries after it are answered normally.
 *
 * `runCassandraFrameCases` drives Studio's real provider through each case and returns what a caller saw, so the
 * same run can be made under Bun in the test process and under Node from a bundle of this file.
 */
import { type AddressInfo, createServer, type Socket } from "node:net";
import { CassandraProvider } from "@/lib/db/providers/sql/cassandra/index";

const MALFORMED_MARKER = "malformed_frame_marker";

export const CASSANDRA_FRAME_CASES = [
  "truncated-error",
  "truncated-auth",
  "header-mismatch",
  "malformed-answer",
] as const;
export type CassandraFrameCase = (typeof CASSANDRA_FRAME_CASES)[number];

const OPCODE = {
  error: 0x00,
  startup: 0x01,
  ready: 0x02,
  authenticate: 0x03,
  options: 0x05,
  supported: 0x06,
  query: 0x07,
  result: 0x08,
  register: 0x0b,
} as const;
const PROTOCOL_ERROR = 0x000a;
const VARCHAR = 0x000d;
const LOCAL_ROW: ReadonlyArray<readonly [string, string]> = [
  ["key", "local"],
  ["cluster_name", "fake cluster"],
  ["data_center", "datacenter1"],
  ["rack", "rack1"],
  ["release_version", "4.1.0"],
  ["partitioner", "org.apache.cassandra.dht.Murmur3Partitioner"],
];

function frame(version: number, streamId: number, opcode: number, body: Buffer): Buffer {
  const head = Buffer.alloc(9);
  head[0] = 0x80 | version;
  head.writeInt16BE(streamId, 2);
  head[4] = opcode;
  head.writeUInt32BE(body.length, 5);
  return Buffer.concat([head, body]);
}

function cqlString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function int(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

/** A RESULT of kind Rows, every column text, under one global table spec. */
function rows(columns: readonly string[], values: ReadonlyArray<readonly string[]>): Buffer {
  const parts = [int(2), int(columns.length === 0 ? 0 : 0x0001), int(columns.length)];
  if (columns.length > 0) parts.push(cqlString("system"), cqlString("local"));
  for (const column of columns) parts.push(cqlString(column), Buffer.from([0x00, VARCHAR]));
  parts.push(int(values.length));
  for (const row of values) {
    for (const value of row) {
      const bytes = Buffer.from(value, "utf8");
      parts.push(int(bytes.length), bytes);
    }
  }
  return Buffer.concat(parts);
}

/** The frame a case sends instead of a parseable answer, at the version and stream of the frame it answers. */
function truncatedError(version: number, streamId: number): Buffer {
  return frame(version, streamId, OPCODE.error, Buffer.from([0x00, 0x00]));
}

/** What the peer saw: every connection it accepted, and how many of them have closed. */
interface FakePeerLog {
  accepted: number;
  closed: number;
  queries: string[];
}

interface FakeCassandraPeer {
  readonly port: number;
  readonly log: FakePeerLog;
  close(): Promise<void>;
}

async function startFakeCassandraPeer(mode: CassandraFrameCase): Promise<FakeCassandraPeer> {
  const log: FakePeerLog = { accepted: 0, closed: 0, queries: [] };
  const sockets = new Set<Socket>();
  let startupsAnswered = 0;

  const answer = (socket: Socket, version: number, streamId: number, opcode: number, body: Buffer): void => {
    if (opcode === OPCODE.startup && version > 4) {
      const message = `Invalid or unsupported protocol version (${version}); supported versions are (3/v3, 4/v4)`;
      socket.write(frame(4, streamId, OPCODE.error, Buffer.concat([int(PROTOCOL_ERROR), cqlString(message)])));
      return;
    }
    if (opcode === OPCODE.startup) {
      startupsAnswered += 1;
      if (startupsAnswered === 1 && mode === "truncated-error") {
        socket.write(truncatedError(version, streamId));
        return;
      }
      if (startupsAnswered === 1 && mode === "truncated-auth") {
        // AUTHENTICATE with a [string] whose 2-byte length says 4000 bytes, in a 3-byte body.
        socket.write(frame(version, streamId, OPCODE.authenticate, Buffer.from([0x0f, 0xa0, 0x41])));
        return;
      }
      if (startupsAnswered === 1 && mode === "header-mismatch") {
        const v1Ready = Buffer.from([0x81, 0x00, 0x00, OPCODE.ready, 0, 0, 0, 0]);
        const v4Cut = Buffer.from([0x84, 0x00, 0x00, 0x00, OPCODE.ready, 0, 0, 0]);
        socket.write(Buffer.concat([v1Ready, v4Cut]));
        return;
      }
      socket.write(frame(version, streamId, OPCODE.ready, Buffer.alloc(0)));
      return;
    }
    if (opcode === OPCODE.options) {
      // An empty [string multimap]: no options to advertise.
      socket.write(frame(version, streamId, OPCODE.supported, Buffer.from([0x00, 0x00])));
      return;
    }
    if (opcode === OPCODE.register) {
      socket.write(frame(version, streamId, OPCODE.ready, Buffer.alloc(0)));
      return;
    }
    if (opcode === OPCODE.query) {
      const text = body.subarray(4, 4 + body.readInt32BE(0)).toString("utf8");
      log.queries.push(text);
      if (text.includes(MALFORMED_MARKER)) {
        socket.write(truncatedError(version, streamId));
        return;
      }
      const result = text.includes("system.local")
        ? rows(
            LOCAL_ROW.map(([name]) => name),
            [LOCAL_ROW.map(([, value]) => value)],
          )
        : rows([], []);
      socket.write(frame(version, streamId, OPCODE.result, result));
      return;
    }
    const message = `The fake peer does not answer opcode ${opcode}`;
    socket.write(frame(version, streamId, OPCODE.error, Buffer.concat([int(PROTOCOL_ERROR), cqlString(message)])));
  };

  const server = createServer((socket) => {
    log.accepted += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      log.closed += 1;
      sockets.delete(socket);
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 9) {
        const version = buffered[0] & 0x7f;
        const length = buffered.readUInt32BE(5);
        if (buffered.length < 9 + length) return;
        const streamId = buffered.readInt16BE(2);
        const opcode = buffered[4];
        const body = buffered.subarray(9, 9 + length);
        buffered = buffered.subarray(9 + length);
        answer(socket, version, streamId, opcode, body);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** How one case ended for its caller. */
export interface CassandraFrameOutcome {
  readonly name: CassandraFrameCase;
  /** The connect's outcome: "resolved", or the error's class name and message. */
  readonly connect: string;
  /** The malformed query's outcome, for `malformed-answer` only. */
  readonly malformedQuery: string | null;
  /** The next query's outcome on the same provider, for `malformed-answer` only. */
  readonly nextQuery: string | null;
  /** Wall time from the start of the call that met the malformed frame to its settling. */
  readonly settledMs: number;
  /** Connections the peer had accepted and seen closed when the call that meets the malformed frame started. */
  readonly acceptedBefore: number;
  readonly closedBefore: number;
  /** Connections the peer accepted and saw closed before the provider was disconnected. */
  readonly accepted: number;
  readonly closedBeforeDisconnect: number;
  /** Errors that reached the process instead of a caller while this case ran. */
  readonly uncaught: readonly string[];
}

/** The provider's read timeout in every case: what a frame the driver never finishes reading costs the caller. */
export const FAKE_PEER_READ_TIMEOUT_MS = 6_000;

async function settle(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "resolved";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : `thrown: ${String(error)}`;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a condition the peer can observe, up to a bound; the caller's assertions say what was not reached. */
async function waitFor(condition: () => boolean, boundMs: number): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

async function runCase(name: CassandraFrameCase): Promise<CassandraFrameOutcome> {
  const uncaught: string[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  const peer = await startFakeCassandraPeer(name);
  const provider = new CassandraProvider(
    {
      id: `fake-cassandra-${name}`,
      name: "fake cassandra",
      type: "cassandra",
      host: "127.0.0.1",
      port: peer.port,
      localDataCenter: "datacenter1",
      createdAt: new Date(),
    },
    { queryTimeout: FAKE_PEER_READ_TIMEOUT_MS },
  );
  try {
    let started = Date.now();
    const connect = await settle(() => provider.connect());
    let malformedQuery: string | null = null;
    let nextQuery: string | null = null;
    let acceptedBefore = 0;
    let closedBefore = 0;
    if (name === "malformed-answer") {
      acceptedBefore = peer.log.accepted;
      closedBefore = peer.log.closed;
      started = Date.now();
      malformedQuery = await settle(() => provider.query(`SELECT ${MALFORMED_MARKER} FROM system.local`));
    }
    const settledMs = Date.now() - started;
    if (name === "malformed-answer") {
      // The driver's control connection reconnects as soon as its connection closes and reads the topology again
      // on the new one; the next query goes out once that read is answered and the host is back up.
      const marker = peer.log.queries.findIndex((text) => text.includes(MALFORMED_MARKER));
      await waitFor(() => peer.log.queries.slice(marker + 1).includes("SELECT * FROM system.peers"), 3_000);
      await sleep(100);
      nextQuery = await settle(() => provider.query("SELECT key FROM system.local"));
    } else {
      // A closed connection reaches the peer as a close event a moment after the client closed it.
      await waitFor(() => peer.log.closed === peer.log.accepted, 2_000);
    }
    const accepted = peer.log.accepted;
    const closedBeforeDisconnect = peer.log.closed;
    await provider.disconnect();
    // One more turn of the loop, so an error raised while the connections close is counted against this case.
    await sleep(50);
    return {
      name,
      connect,
      malformedQuery,
      nextQuery,
      settledMs,
      acceptedBefore,
      closedBefore,
      accepted,
      closedBeforeDisconnect,
      uncaught,
    };
  } finally {
    await peer.close();
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  }
}

/** Every case in order, one at a time, so an error that escapes is counted against the case that raised it. */
export async function runCassandraFrameCases(): Promise<CassandraFrameOutcome[]> {
  const outcomes: CassandraFrameOutcome[] = [];
  for (const name of CASSANDRA_FRAME_CASES) outcomes.push(await runCase(name));
  return outcomes;
}
