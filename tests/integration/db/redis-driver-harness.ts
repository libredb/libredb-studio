/**
 * Runtime harness for the ioredis reply and stream checks of redis-driver.test.ts.
 *
 * Studio's RedisProvider runs over the real ioredis here, against a local peer that speaks enough RESP for a connect
 * and then answers as each case says. Two kinds of failure are driven through it:
 *
 *  - a reply the parser cannot hold: an array header no JS array can take (`*4294967296`), or arrays nested deeper
 *    than the stack, answered to a command, to the first command of a connect, or to the `SELECT` or the agent
 *    read-only proof a connect sends after it;
 *  - on a TLS connection, one record the client cannot decrypt written under the TLS layer: in place of the answer to a
 *    command, to a connect or to a reconnect, with the socket kept open, or on an idle connection, then a reset or one
 *    more command;
 *  - a reset in place of the answer to a command.
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
import type { ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/** Every error that escaped a call instead of reaching its caller, in order. */
const escaped: string[] = [];
process.on("uncaughtException", (error) => escaped.push(`uncaughtException: ${error.message}`));
process.on("unhandledRejection", (reason) =>
  escaped.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`),
);

/** Every `[Redis]` warning the provider logged, in order: an error the client's listener took after connecting. */
const logged: string[] = [];
/** Called once the next `[Redis]` warning is logged, when a case waits for one. */
let onLogged: (() => void) | undefined;
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes("[Redis]")) {
    logged.push(line.slice(line.indexOf("[Redis]")));
    onLogged?.();
  }
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

/**
 * A local RESP peer. With `halfOpen`, it keeps its side of a connection open after the client ends its own, as a server
 * may, so the client's socket stays open until ioredis's disconnect timeout destroys it.
 */
async function startPeer(secure: boolean, halfOpen: boolean): Promise<Peer> {
  const connections: PeerConnection[] = [];
  const peer: Peer = { port: 0, connections, answer: () => undefined, close: () => undefined };
  const server = net.createServer({ allowHalfOpen: halfOpen }, (raw) => {
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
  /** How many times the peer received the command the fault answered, when the case counts it. */
  readonly delivered?: number;
  readonly logged: string[];
  readonly escaped: string[];
}

/** What a case changes on the provider it opens: connection fields, and the execution context it is opened under. */
interface Opening {
  readonly fields?: Partial<DatabaseConnection>;
  readonly execution?: ProviderExecutionContext;
  /** The peer keeps its side of the connection open after the client ends its own. */
  readonly halfOpen?: boolean;
}

async function runCase(
  name: string,
  secure: boolean,
  body: (provider: RedisProvider, peer: Peer) => Promise<{ call: string; next?: string; delivered?: number }>,
  opening: Opening = {},
): Promise<CaseReport> {
  escaped.length = 0;
  logged.length = 0;
  const peer = await startPeer(secure, opening.halfOpen ?? false);
  const provider = new RedisProvider(
    { ...connection(peer.port, secure), ...opening.fields },
    { queryTimeout: 5_000 },
    opening.execution,
  );
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

/** Answers the first command named `name` with `reply`, once, and every other command with the default answer. */
function onFirst(name: string, reply: string | Buffer): Answer {
  let sent = false;
  return (command) => {
    if (sent || (command[0] ?? "").toUpperCase() !== name) return undefined;
    sent = true;
    return reply;
  };
}

/** Answers the first `GET` with `reply`, once: ioredis does not resend a command its fatal-error path rejected. */
function onGet(reply: string | Buffer): Answer {
  return onFirst("GET", reply);
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

/**
 * The opening under which `connect()` sends `step` after the sign-in: the `SELECT` of numbered database 1, or the
 * `HELLO 2` that opens the agent read-only profile's proof.
 */
function stepOpening(step: "SELECT" | "HELLO"): Opening {
  return step === "SELECT"
    ? { fields: { database: "1" } }
    : { fields: { user: "agent" }, execution: { readOnly: true, sendsStatements: true } };
}

/** Answers a command `connect()` sends after the sign-in with `reply`. */
async function connectStepCase(name: string, step: "SELECT" | "HELLO", reply: string | Buffer): Promise<CaseReport> {
  return runCase(
    name,
    false,
    async (provider, peer) => {
      peer.answer = onFirst(step, reply);
      return { call: await settle(4_000, () => provider.connect()) };
    },
    stepOpening(step),
  );
}

/** Writes the unreadable record in place of the answer to a command `connect()` sends after the sign-in. */
async function recordStepCase(name: string, step: "SELECT" | "HELLO"): Promise<CaseReport> {
  return runCase(
    name,
    true,
    async (provider, peer) => {
      peer.answer = recordFor(step);
      return { call: await settle(4_000, () => provider.connect()) };
    },
    stepOpening(step),
  );
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

/**
 * Writes the unreadable record where an answer to `name` belongs, once, and keeps the socket open: nothing but the
 * record tells the client that this connection cannot answer the command any more.
 */
function recordFor(name: string): Answer {
  let sent = false;
  return (command, { raw }) => {
    if (sent || (command[0] ?? "").toUpperCase() !== name) return undefined;
    sent = true;
    raw.write(UNREADABLE_TLS_RECORD);
    return "silence";
  };
}

/** Counts the `name` commands the peer receives, and answers each as `answer` says. */
function counting(name: string, answer: Answer): { answer: Answer; count: () => number } {
  let count = 0;
  return {
    answer: (command, connection) => {
      if ((command[0] ?? "").toUpperCase() === name) count++;
      return answer(command, connection);
    },
    count: () => count,
  };
}

/** Resolves once the provider has logged a `[Redis]` warning, or after `ms`. */
async function untilLogged(ms: number): Promise<void> {
  if (logged.length > 0) return;
  await Promise.race([new Promise<void>((resolve) => (onLogged = resolve)), sleep(ms)]);
  onLogged = undefined;
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
cases.push(await connectStepCase("oversized array header answering SELECT", "SELECT", OVERSIZED_ARRAY_HEADER));
cases.push(await connectStepCase("deeply nested reply answering SELECT", "SELECT", DEEP_REPLY));
cases.push(
  await connectStepCase("oversized array header answering the read-only proof", "HELLO", OVERSIZED_ARRAY_HEADER),
);
cases.push(await connectStepCase("deeply nested reply answering the read-only proof", "HELLO", DEEP_REPLY));
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
cases.push(
  await runCase("unreadable TLS record while a command waits", true, async (provider, peer) => {
    await provider.connect();
    const get = counting("GET", recordFor("GET"));
    peer.answer = get.answer;
    const call = await settle(4_000, () => provider.query("GET k"));
    const next = await settle(4_000, () => provider.query("PING"));
    return { call, next, delivered: get.count() };
  }),
);
cases.push(
  await runCase("unreadable TLS record while connecting", true, async (provider, peer) => {
    peer.answer = recordFor("INFO");
    return { call: await settle(4_000, () => provider.connect()) };
  }),
);
cases.push(await recordStepCase("unreadable TLS record answering SELECT", "SELECT"));
cases.push(await recordStepCase("unreadable TLS record answering the read-only proof", "HELLO"));

cases.push(
  await runCase(
    "unreadable TLS record then reset while the connection closes",
    true,
    async (provider, peer) => {
      await provider.connect();
      const { raw } = peer.connections[peer.connections.length - 1];
      raw.write(UNREADABLE_TLS_RECORD);
      // The record closes the connection: the client ends its side, and the peer keeps its own open, then resets it.
      await sleep(300);
      raw.resetAndDestroy();
      await sleep(300);
      return { call: "ok", next: await settle(8_000, () => provider.query("PING")) };
    },
    { halfOpen: true },
  ),
);
cases.push(
  await runCase(
    "unreadable TLS record, then a command sent while the client reconnects",
    true,
    async (provider, peer) => {
      await provider.connect();
      const get = counting("GET", () => undefined);
      // The next connection's first CLIENT SETINFO is answered by the record too, so it closes before it is ready.
      const record = recordFor("CLIENT");
      peer.answer = (command, connection) => record(command, connection) ?? get.answer(command, connection);
      peer.connections[peer.connections.length - 1].raw.write(UNREADABLE_TLS_RECORD);
      await untilLogged(4_000);
      const call = await settle(8_000, () => provider.query("GET k"));
      return { call, delivered: get.count() };
    },
  ),
);
cases.push(
  await runCase("reset while a command waits", true, async (provider, peer) => {
    await provider.connect();
    let sent = false;
    const get = counting("GET", (command, { raw }) => {
      if (sent || (command[0] ?? "").toUpperCase() !== "GET") return undefined;
      sent = true;
      raw.resetAndDestroy();
      return "silence";
    });
    peer.answer = get.answer;
    const call = await settle(4_000, () => provider.query("GET k"));
    const next = await settle(4_000, () => provider.query("PING"));
    return { call, next, delivered: get.count() };
  }),
);

console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", cases }));
process.exit(0);
