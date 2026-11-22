/**
 * The guarded adapter's answer to a 101 that announces an upgrade (`httpTransportFetch` handed a decision that
 * blocks private destinations, src/lib/db/http/egress-policy.ts).
 *
 * The guard refuses every local address by design, so `node:http`'s request is wrapped to dial the local peer in place
 * of the public name the guard checked; the request, the socket and the 101 are otherwise node:http's own. The runner
 * starts a process per file, so the wrapper reaches no other test file.
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { answerWithUpgrade, type UpgradeAnswer } from "../../../helpers/upgrade-answer";
import { BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const realHttp = { ...(await import("node:http")) };
mock.module("node:http", () => ({
  ...realHttp,
  request: (options: RequestOptions, onResponse: (incoming: IncomingMessage) => void): ClientRequest =>
    realHttp.request({ ...options, hostname: "127.0.0.1", lookup: undefined }, onResponse),
}));

// The guarded path never takes the native fetch. Were the guard to decide by anything but the decision it is handed,
// a case would pass its URL to the unguarded fetch; this stub fails such a case at once by this sentence, and nothing
// leaves the machine.
globalThis.fetch = (() => {
  throw new Error("the unguarded path took globalThis.fetch");
}) as unknown as typeof fetch;

const { httpTransportFetch } = await import("@/lib/db/http/egress-policy");

const SWITCHED = "The server switched the connection to another protocol instead of answering, so no answer was read";

/** How the peer answers the next request, and one promise per switched socket, resolved once it has closed. */
let answer: UpgradeAnswer | "ok" = "ok";
const upgradedSockets: Promise<void>[] = [];
const accepted: Socket[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => {});
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      head = "";
      if (answer === "ok") socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      else upgradedSockets.push(answerWithUpgrade(socket, answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of accepted) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  answer = "ok";
  upgradedSockets.length = 0;
});

test("the wrapped dial reaches the local peer through the guarded path", async () => {
  const response = await httpTransportFetch(`http://db.example.com:${port}/query`, {}, BLOCKS_PRIVATE_HOSTS);
  expect([response.status, await response.text()]).toEqual([200, "ok"]);
});

test.each(["upgrade", "upgrade-close"] as const)(
  "a 101 that announces an upgrade (%s) rejects at once by name, and the switched socket is closed",
  async (upgrade) => {
    answer = upgrade;
    const started = Date.now();
    // A plain await, so a call that never settles fails by the test's own timeout.
    let failure: unknown;
    try {
      await httpTransportFetch(
        `http://db.example.com:${port}/query`,
        { method: "POST", body: "{}" },
        BLOCKS_PRIVATE_HOSTS,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect({ name: (failure as Error).name, message: (failure as Error).message }).toEqual({
      name: "SwitchedProtocolsError",
      message: SWITCHED,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(upgradedSockets).toHaveLength(1);
    await Promise.all(upgradedSockets);
  },
);
