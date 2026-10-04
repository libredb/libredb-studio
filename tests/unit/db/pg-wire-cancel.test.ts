/**
 * The PostgreSQL wire-protocol CancelRequest (#1364), against a real socket.
 *
 * The server side is a plain `net` server that does what a PostgreSQL server does with a
 * CancelRequest: reads the 16 bytes and closes the connection without answering. The bytes
 * are checked against the protocol's layout rather than against this module's own builder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelRequestMessage, sendPgCancelRequest } from "@/lib/db/providers/sql/pg-wire-cancel";

let server: Server | null = null;
let socketDir: string | null = null;
/** Every server-side socket, destroyed after each test: `close()` waits for open ones. */
let accepted: Socket[] = [];

afterEach(async () => {
  for (const socket of accepted) socket.destroy();
  accepted = [];
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  socketDir = null;
});

/** A server that collects what each connection sent and then does `onData` with the socket. */
function listen(
  onData: (socket: Socket) => void,
  path?: string,
  allowHalfOpen = false,
): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  // `allowHalfOpen` keeps the server's side open after the client's FIN, which otherwise
  // closes it on its own.
  server = createServer({ allowHalfOpen }, (socket) => {
    accepted.push(socket);
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      onData(socket);
    });
  });
  return new Promise((resolve) => {
    const ready = () => {
      const address = server!.address();
      resolve({ port: typeof address === "object" && address !== null ? address.port : 0, received });
    };
    if (path) server!.listen(path, ready);
    else server!.listen(0, "127.0.0.1", ready);
  });
}

describe("cancelRequestMessage", () => {
  test("is length 16, code 80877102, then the process id and the secret key", () => {
    const message = cancelRequestMessage(1990112, -1029646662);
    expect(message.length).toBe(16);
    expect(message.readInt32BE(0)).toBe(16);
    expect(message.readInt32BE(4)).toBe((1234 << 16) | 5678);
    expect(message.readInt32BE(8)).toBe(1990112);
    // A negative key is a valid Int32: CockroachDB v26.3.2 handed out -1029646662.
    expect(message.readInt32BE(12)).toBe(-1029646662);
  });
});

describe("sendPgCancelRequest", () => {
  test("sends the request and resolves true once the server closes the connection", async () => {
    const { port, received } = await listen((socket) => socket.end());

    const sent = await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 42, secretKey: 7 }, 2000);

    expect(sent).toBe(true);
    expect(Buffer.concat(received).equals(cancelRequestMessage(42, 7))).toBe(true);
  });

  test("reaches a server listening in a Unix socket directory", async () => {
    socketDir = mkdtempSync(join(tmpdir(), "pgcancel-"));
    const { received } = await listen((socket) => socket.end(), join(socketDir, ".s.PGSQL.5432"));

    const sent = await sendPgCancelRequest({ host: socketDir, port: 5432, processID: 3, secretKey: 4 }, 2000);

    expect(sent).toBe(true);
    expect(Buffer.concat(received).equals(cancelRequestMessage(3, 4))).toBe(true);
  });

  test("sends nothing when the check before sending says the session moved on", async () => {
    const { port, received } = await listen((socket) => socket.end());

    const sent = await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 42, secretKey: 7 }, 2000, () => false);

    expect(sent).toBe(false);
    expect(received).toEqual([]);
  });

  test("resolves false when nothing listens", async () => {
    const { port } = await listen(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    expect(await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 1, secretKey: 1 }, 2000)).toBe(false);
  });

  test("resolves false when the server never closes the connection", async () => {
    const { port } = await listen(() => {}, undefined, true);

    expect(await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 1, secretKey: 1 }, 100)).toBe(false);
  });
});
