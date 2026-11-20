/**
 * Runtime harness for the ioredis reply and stream checks of redis-driver.test.ts.
 *
 * Studio's RedisProvider runs over the real ioredis here, against a local peer that speaks enough RESP for a connect
 * and then answers as each case says. Two kinds of failure are driven through it:
 *
 *  - a reply the parser cannot hold: an array header no JS array can take (`*4294967296`), or arrays nested deeper
 *    than the stack, answered to a command or to the first command of a connect;
 *  - on a TLS connection, one record the client cannot decrypt written under the TLS layer, then a reset, or one more
 *    client write, which Node reports as a second `error` on the same socket.
 *
 * Each case records what the caller got, what the next command got, the `[Redis]` warnings the provider logged, and
 * every error that escaped a call instead of reaching its caller (uncaughtException, unhandledRejection). The test runs this file twice, under Bun and, bundled
 * with `bun build --target=node`, under Node, because the two runtimes report an error raised in a socket handler
 * differently. It prints one JSON report on stdout. The peer's certificate and key come in the environment
 * (REDIS_HARNESS_TLS_CERT, REDIS_HARNESS_TLS_KEY) because the fixture loader reads its directory in a Bun-only way.
 */
import net from "node:net";
import tls from "node:tls";
import { RedisProvider } from "@/lib/db/providers/keyvalue/redis";
import type { DatabaseConnection } from "@/lib/types";

/** Every error that escaped a call instead of reaching its caller, in order. */
const escaped: string[] = [];
process.on("uncaughtException", (error) => escaped.push(`uncaughtException: ${error.message}`));
process.on("unhandledRejection", (reason) =>
  escaped.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`),
);

/** Every `[Redis]` warning the provider logged, in order: an error the client's listener took after connecting. */
const logged: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes("[Redis]")) logged.push(line.slice(line.indexOf("[Redis]")));
  warn(...args);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A TLS 1.2/1.3 application-data record of 16 bytes that no session key decrypts. */
const UNREADABLE_TLS_RECORD = Buffer.from("170303001000112233445566778899aabbccddeeff", "hex");
/** An array header for 2^32 elements: one more than a JS array can hold. */
const OVERSIZED_ARRAY_HEADER = "*4294967296\r\n";
/** 200000 arrays of one element, nested, around one integer: deeper than either runtime's stack. */
const DEEP_REPLY = Buffer.concat([Buffer.from("*1\r\n".repeat(200_000)), Buffer.from(":1\r\n")]);

interface PeerConnection {
  /** The socket RESP is spoken on: the TLS socket, or the TCP one for a plaintext peer. */
  readonly socket: net.Socket;
  /** The TCP socket under it, where a record can be written past the TLS layer. */
  readonly raw: net.Socket;
}

/** What the peer answers to one command: a reply, `silence`, or `undefined` for its default answer. */
type Answer = (command: string[], connection: PeerConnection) => string | Buffer | "silence" | undefined;

interface Peer {
  readonly port: number;
  readonly connections: PeerConnection[];
  answer: Answer;
  close(): void;
}

/** The complete RESP commands at the front of `buffer`, and the bytes after them. */
function readCommands(buffer: Buffer): [string[][], Buffer] {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n", offset);
    if (headerEnd < 0) break;
    const count = Number(buffer.subarray(offset + 1, headerEnd).toString());
    let cursor = headerEnd + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i++) {
      const lengthEnd = buffer.indexOf("\r\n", cursor);
      if (lengthEnd < 0) return [commands, buffer.subarray(offset)];
      const length = Number(buffer.subarray(cursor + 1, lengthEnd).toString());
      if (lengthEnd + 2 + length + 2 > buffer.length) return [commands, buffer.subarray(offset)];
      args.push(buffer.subarray(lengthEnd + 2, lengthEnd + 2 + length).toString());
      cursor = lengthEnd + 2 + length + 2;
    }
    commands.push(args);
    offset = cursor;
  }
  return [commands, buffer.subarray(offset)];
}

const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;

function defaultAnswer(command: string[]): string {
  const name = (command[0] ?? "").toUpperCase();
  if (name === "INFO") return bulk("# Server\r\nredis_version:8.10.2\r\nloading:0\r\n");
  if (name === "PING") return "+PONG\r\n";
  if (name === "GET") return bulk("value");
  return "+OK\r\n";
}

async function startPeer(secure: boolean): Promise<Peer> {
  const connections: PeerConnection[] = [];
  const peer: Peer = { port: 0, connections, answer: () => undefined, close: () => undefined };
  const server = net.createServer((raw) => {
    const socket = secure
      ? new tls.TLSSocket(raw, {
          isServer: true,
          cert: process.env.REDIS_HARNESS_TLS_CERT,
          key: process.env.REDIS_HARNESS_TLS_KEY,
        })
      : raw;
    const connection = { socket, raw };
    connections.push(connection);
    // The peer's own sockets fail on purpose in these cases; their errors are the peer's, not the client's.
    socket.on("error", () => undefined);
    raw.on("error", () => undefined);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      let commands: string[][];
      [commands, pending] = readCommands(Buffer.concat([pending, chunk]));
      for (const command of commands) {
        const scripted = peer.answer(command, connection);
        if (scripted === "silence") continue;
        socket.write(scripted ?? defaultAnswer(command));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(peer, {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const { raw } of connections) raw.destroy();
      server.close();
    },
  });
}

/** How a call settled: `ok <first row>`, `<ErrorClass>: <message>`, or `pending` after `ms`. */
async function settle(ms: number, run: () => Promise<{ rows: unknown[] } | void>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`pending after ${ms} ms`), ms);
  });
  try {
    return await Promise.race([
      run().then((answer) => (answer ? `ok ${JSON.stringify(answer.rows[0])}` : "ok")),
      pending,
    ]);
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(timer);
  }
}

function connection(port: number, secure: boolean): DatabaseConnection {
  return {
    id: "redis-driver-harness",
    name: "redis-driver-harness",
    type: "redis",
    host: "127.0.0.1",
    port,
    createdAt: new Date(),
    ...(secure ? { ssl: { mode: "require" as const } } : {}),
  };
}

interface CaseReport {
  readonly name: string;
  /** What the call the fault answered settled with (the command, or connect()). */
  readonly call: string;
  /** What the next command on the same provider settled with, when the case sends one. */
  readonly next?: string;
  readonly logged: string[];
  readonly escaped: string[];
}

async function runCase(
  name: string,
  secure: boolean,
  body: (provider: RedisProvider, peer: Peer) => Promise<{ call: string; next?: string }>,
): Promise<CaseReport> {
  escaped.length = 0;
  logged.length = 0;
  const peer = await startPeer(secure);
  const provider = new RedisProvider(connection(peer.port, secure), { queryTimeout: 5_000 });
  try {
    const outcome = await body(provider, peer);
    // A second socket error lands after the call settles, so the case waits before it reads the record.
    await sleep(300);
    return { name, ...outcome, logged: [...logged], escaped: [...escaped] };
  } finally {
    // Bounded: a connection left waiting never answers the QUIT a disconnect sends.
    await settle(2_000, () => provider.disconnect());
    peer.close();
  }
}

/** Answers the first `GET` with `reply`, once: ioredis does not resend a command its fatal-error path rejected. */
function onGet(reply: string | Buffer): Answer {
  let sent = false;
  return (command) => {
    if (sent || (command[0] ?? "").toUpperCase() !== "GET") return undefined;
    sent = true;
    return reply;
  };
}

async function replyCase(name: string, reply: string | Buffer): Promise<CaseReport> {
  return runCase(name, false, async (provider, peer) => {
    await provider.connect();
    peer.answer = onGet(reply);
    const call = await settle(4_000, () => provider.query("GET k"));
    const next = await settle(4_000, () => provider.query("PING"));
    return { call, next };
  });
}

/** Writes the unreadable record on the provider's idle connection, then `then` follows it. */
async function idleRecordCase(name: string, then: "reset" | "command"): Promise<CaseReport> {
  return runCase(name, true, async (provider, peer) => {
    await provider.connect();
    const { raw } = peer.connections[peer.connections.length - 1];
    raw.write(UNREADABLE_TLS_RECORD);
    await sleep(150);
    if (then === "reset") {
      raw.resetAndDestroy();
      await sleep(300);
      return { call: "ok", next: await settle(4_000, () => provider.query("PING")) };
    }
    return { call: await settle(4_000, () => provider.query("PING")) };
  });
}

const cases: CaseReport[] = [];
cases.push(await replyCase("oversized array header", OVERSIZED_ARRAY_HEADER));
cases.push(await replyCase("deeply nested reply", DEEP_REPLY));
cases.push(
  await runCase("oversized array header while connecting", false, async (provider, peer) => {
    peer.answer = () => OVERSIZED_ARRAY_HEADER;
    return { call: await settle(4_000, () => provider.connect()) };
  }),
);
cases.push(await idleRecordCase("unreadable TLS record then reset", "reset"));
cases.push(await idleRecordCase("unreadable TLS record then a command", "command"));
cases.push(
  await runCase("unreadable TLS record while connecting, then reset", true, async (provider, peer) => {
    peer.answer = (_command, { raw }) => {
      raw.write(UNREADABLE_TLS_RECORD);
      setTimeout(() => raw.resetAndDestroy(), 150);
      return "silence";
    };
    return { call: await settle(4_000, () => provider.connect()) };
  }),
);

console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", cases }));
process.exit(0);
