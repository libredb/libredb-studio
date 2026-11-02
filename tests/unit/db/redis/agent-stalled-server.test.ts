/**
 * An agent command against a server that stops answering, over the real ioredis driver and a TCP peer that speaks
 * the protocol until it is told to hold every byte it receives, as a server held by `DEBUG SLEEP` or a proxy that
 * stalls does. The peer answers the open as Redis 8.10.2 answered the `reader-info` principal
 * (tests/fixtures/redis/8.10.2/agent-boundary/reader-info.json), so the provider opens as it does live.
 *
 * What is pinned: the command's connection is the only one the read opens, and it is never reopened, so the read ends
 * one time left after it began rather than twice that; and nothing the driver sends on its own is left to reject
 * unheard, on database 0 or on a numbered database, whose connection adds a `SELECT`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { RedisProvider } from "@/lib/db/providers/keyvalue/redis";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { type CapturedStep, principalCapture, probeLabel, stepFor } from "../../../helpers/redis-agent";

const CAPTURE = principalCapture("8.10.2", "reader-info");
const HELLO = stepFor(CAPTURE.outside, ["HELLO", "2"]) as CapturedStep;

type Reply = string | number | null | readonly Reply[] | { readonly error: string } | { readonly status: string };

function encode(reply: Reply): string {
  if (reply === null) return "$-1\r\n";
  if (typeof reply === "number") return `:${reply}\r\n`;
  if (typeof reply === "string") return `$${Buffer.byteLength(reply)}\r\n${reply}\r\n`;
  if (Array.isArray(reply)) return `*${reply.length}\r\n${reply.map(encode).join("")}`;
  if ("error" in reply) return `-${reply.error}\r\n`;
  return `+${(reply as { status: string }).status}\r\n`;
}

/** What the peer answers one command, as the captured server answered it. */
function answer(argv: readonly string[]): Reply {
  const command = argv[0].toUpperCase();
  if (command === "AUTH" || command === "SELECT" || command === "CLIENT") return { status: "OK" };
  if (command === "READONLY") return { error: "ERR This instance has cluster support disabled" };
  if (command === "HELLO") return HELLO.reply as Reply;
  if (command === "DBSIZE") return 8;
  const probe = CAPTURE.probes.find((step) => probeLabel(step.argv) === probeLabel(argv));
  if (probe === undefined) return { error: `ERR unknown command '${argv[0]}'` };
  return probe.outcome === "ok" ? (probe.reply as Reply) : { error: probe.error ?? "" };
}

/** The complete commands at the head of `buffer`, and what is left of it. */
function parse(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  for (;;) {
    const start = offset;
    const line = (at: number) => {
      const end = buffer.indexOf("\r\n", at);
      return end < 0 ? null : { text: buffer.toString("utf8", at, end), next: end + 2 };
    };
    const head = line(offset);
    if (head === null) break;
    const count = Number(head.text.slice(1));
    let at = head.next;
    const argv: string[] = [];
    let complete = true;
    for (let index = 0; index < count; index++) {
      const size = line(at);
      if (size === null) {
        complete = false;
        break;
      }
      const length = Number(size.text.slice(1));
      if (buffer.length < size.next + length + 2) {
        complete = false;
        break;
      }
      argv.push(buffer.toString("utf8", size.next, size.next + length));
      at = size.next + length + 2;
    }
    if (!complete) {
      offset = start;
      break;
    }
    commands.push(argv);
    offset = at;
  }
  return { commands, rest: buffer.subarray(offset) };
}

let server: Server;
let port = 0;
/** While true, the peer reads every byte and answers none. */
let holding = false;
/** While true, the peer signs a connection in and closes it at the proof's `HELLO`, as a dropped link does. */
let dropping = false;
let accepted = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (holding) return;
      const { commands, rest } = parse(Buffer.concat([buffer, chunk]));
      buffer = rest;
      const drop = dropping ? commands.findIndex((argv) => argv[0].toUpperCase() === "HELLO") : -1;
      socket.write(
        commands
          .slice(0, drop < 0 ? undefined : drop)
          .map((argv) => encode(answer(argv)))
          .join(""),
      );
      if (drop >= 0) socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const unheard: unknown[] = [];
const onUnhandled = (reason: unknown) => unheard.push(reason);
process.on("unhandledRejection", onUnhandled);
afterEach(() => {
  holding = false;
  dropping = false;
  unheard.length = 0;
});

const TIME_LEFT_MS = 400;
const BUDGET: ReadOnlyStatementBudget = {
  maxResultRows: 200,
  maxResultBytes: 65_536,
  statementTimeoutMs: TIME_LEFT_MS,
};

function connection(database?: string): DatabaseConnection {
  return {
    id: "redis-stalled",
    name: "Redis",
    type: "redis",
    host: "127.0.0.1",
    port,
    user: "agent_reader_info",
    password: "not-a-real-password",
    ...(database === undefined ? {} : { database }),
    createdAt: new Date(0),
  } as DatabaseConnection;
}

describe("an agent command on a server that stops answering", () => {
  for (const database of [undefined, "1"]) {
    test(`ends one time left after it began, on its one connection, with nothing left unheard (database ${database ?? "0"})`, async () => {
      const provider = new RedisProvider(connection(database), {}, { readOnly: true, sendsStatements: true });
      await provider.connect();
      expect((await provider.queryReadOnly("DBSIZE", BUDGET)).rows).toEqual([{ keys: 8 }]);

      holding = true;
      const before = accepted;
      const started = Date.now();
      const error = await provider.queryReadOnly("DBSIZE", BUDGET).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      const settled = Date.now() - started;
      expect((error as Error).message).toBe(
        `Read-only execution exceeded the time budget: no answer within ${TIME_LEFT_MS}ms`,
      );
      expect(settled).toBeGreaterThanOrEqual(TIME_LEFT_MS - 20);
      expect(settled).toBeLessThan(TIME_LEFT_MS * 2);

      // Long past the driver's first reconnect delay and a second time left.
      await Bun.sleep(TIME_LEFT_MS * 2 + 200);
      expect(accepted - before).toBe(1);
      expect(unheard).toEqual([]);
      holding = false;
      await provider.disconnect();
    });
  }

  test("a connection dropped during the proof is not reopened, so nothing is sent again", async () => {
    const provider = new RedisProvider(connection(), {}, { readOnly: true, sendsStatements: true });
    await provider.connect();
    dropping = true;
    const before = accepted;
    const error = await provider.queryReadOnly("DBSIZE", BUDGET).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("NOPERM");
    await Bun.sleep(TIME_LEFT_MS * 2 + 200);
    expect(accepted - before).toBe(1);
    expect(unheard).toEqual([]);
    dropping = false;
    await provider.disconnect();
  });
});
