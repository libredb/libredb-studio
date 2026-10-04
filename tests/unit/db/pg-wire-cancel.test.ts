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
import { TLSSocket } from "node:tls";
import { cancelRequestMessage, sendPgCancelRequest, sslRequestMessage } from "@/lib/db/providers/sql/pg-wire-cancel";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";
import { testIf } from "../../helpers/posix-tools";

const NO_POSIX_SOCKET_DIRECTORY: string | null =
  process.platform === "win32" ? "a socket directory is a POSIX path starting with /" : null;

const TLS = loadTlsFixtures();

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

  // `pg` takes a host starting with "/" as a socket directory, a POSIX path; a Windows
  // temporary directory starts with a drive letter, so the case does not exist there.
  testIf(NO_POSIX_SOCKET_DIRECTORY, "reaches a server listening in a Unix socket directory", async () => {
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

/**
 * A server that answers an SSLRequest the way PostgreSQL does: one byte, `S` then TLS, or `N`.
 * `plain` is what arrived before TLS, `secure` what arrived inside it, and `servername` the
 * name the client asked for (SNI).
 */
async function listenTls(answer: "S" | "N") {
  const seen = { plain: [] as Buffer[], secure: [] as Buffer[], servername: undefined as string | false | undefined };
  server = createServer((socket) => {
    accepted.push(socket);
    socket.once("data", (chunk) => {
      seen.plain.push(Buffer.from(chunk));
      if (answer === "N") {
        socket.end("N");
        return;
      }
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, key: TLS.server.key, cert: TLS.server.cert });
      secure.on("secure", () => {
        seen.servername = (secure as TLSSocket & { servername?: string | false }).servername;
      });
      secure.on("data", (bytes) => {
        seen.secure.push(Buffer.from(bytes));
        secure.end();
      });
      secure.on("error", () => socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, seen };
}

describe("sendPgCancelRequest over TLS", () => {
  // The session was configured with TLS, so the cancel goes the same way: SSLRequest, the
  // upgrade with the session's own TLS options, and only then the key.
  test("asks for TLS, upgrades with the session's options, and sends the request inside it", async () => {
    const { port, seen } = await listenTls("S");

    const sent = await sendPgCancelRequest(
      { host: "127.0.0.1", port, processID: 42, secretKey: 7, ssl: { ca: TLS.ca } },
      2000,
    );

    expect(sent).toBe(true);
    expect(Buffer.concat(seen.plain).equals(sslRequestMessage())).toBe(true);
    expect(Buffer.concat(seen.secure).equals(cancelRequestMessage(42, 7))).toBe(true);
  });

  // `pg` names the host as the TLS server name unless it is an IP address; an SNI proxy in
  // front of a managed database routes on it.
  test("names a host as the TLS server name, and an IP address not at all", async () => {
    const byName = await listenTls("S");
    expect(
      await sendPgCancelRequest(
        { host: "localhost", port: byName.port, processID: 1, secretKey: 2, ssl: { ca: TLS.ca } },
        2000,
      ),
    ).toBe(true);
    expect(byName.seen.servername).toBe("localhost");
    for (const socket of accepted) socket.destroy();
    accepted = [];
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const byIp = await listenTls("S");
    await sendPgCancelRequest(
      { host: "127.0.0.1", port: byIp.port, processID: 1, secretKey: 2, ssl: { ca: TLS.ca } },
      2000,
    );
    // No SNI: node reports `false`, bun `undefined`.
    expect(byIp.seen.servername || undefined).toBeUndefined();
  });

  // The session required TLS; a server that will not speak it does not get the key in clear.
  test("sends nothing when the server refuses TLS", async () => {
    const { port, seen } = await listenTls("N");

    const sent = await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 42, secretKey: 7, ssl: true }, 2000);

    expect(sent).toBe(false);
    expect(Buffer.concat(seen.plain).equals(sslRequestMessage())).toBe(true);
    expect(seen.secure).toEqual([]);
  });

  test("sends nothing when the server's certificate is not trusted", async () => {
    const { port, seen } = await listenTls("S");

    // `ssl: true` verifies against the system roots, which never signed the test CA.
    expect(await sendPgCancelRequest({ host: "127.0.0.1", port, processID: 1, secretKey: 2, ssl: true }, 2000)).toBe(
      false,
    );
    expect(
      await sendPgCancelRequest(
        { host: "127.0.0.1", port, processID: 1, secretKey: 2, ssl: { ca: TLS.otherCa } },
        2000,
      ),
    ).toBe(false);
    expect(seen.secure).toEqual([]);
  });
});
