/**
 * The two library calls `dialNetconf` makes, against the real runtime they are written for.
 *
 * `node-ports.ts` says of itself that everything deciding anything lives above it and that what is
 * left cannot be tested without a network: opening a TCP socket, running the SSH handshake, and
 * turning ssh2's channel into the session's byte transport. That sentence was true and the file was
 * therefore the provider's largest uncovered surface, 36 of the 70 lines the coverage gate names.
 *
 * So the network is real and only the far end is ours: a loopback TCP server for the socket half,
 * and `ssh2`'s own `Server` for the SSH half, with a key generated per run. Nothing here stubs the
 * module under test, which is the whole point - a stub would measure this file's shape rather than
 * the two calls it exists to make.
 *
 * The server speaks the same subsystem the provider asks for, `netconf`, and answers one hello, so
 * the channel that comes back is a channel a device would have opened rather than a shape invented
 * here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lookup as dnsLookup } from "node:dns";
import { createServer, type Server as TcpServer, type Socket } from "node:net";
import { Server as SshServer, utils } from "ssh2";
import { nodeSocketPort, nodeSshPort, transportOf } from "@/lib/db/providers/network/netconf/node-ports";

const HELLO = '<?xml version="1.0"?><hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"/>';
const USER = "ro-pass";
const PASSWORD = "fixture-password";

let tcp: TcpServer;
let tcpPort = 0;
let ssh: SshServer;
let sshPort = 0;

beforeAll(async () => {
  tcp = createServer(() => {});
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const tcpAddress = tcp.address();
  if (tcpAddress === null || typeof tcpAddress === "string") throw new Error("the TCP server took no port");
  tcpPort = tcpAddress.port;
  tcp.unref();

  // ECDSA rather than ed25519: an ed25519 key from ssh2 1.17.0's own generator fails ssh2's own parser about
  // 4 times in 1,000 ("Malformed OpenSSH private key", measured on Node 24.14 and Bun 1.4.2), which failed this
  // file at random; 3,000 ECDSA keys all parsed.
  const key = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  ssh = new SshServer({ hostKeys: [key.private] }, (client) => {
    client.on("authentication", (ctx) => (ctx.method === "password" ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("subsystem", (sAccept, sReject, info) => {
          if (info.name !== "netconf") {
            sReject();
            return;
          }
          const channel = sAccept();
          channel.write(HELLO);
        });
      });
    });
  });
  await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  sshPort = (ssh.address() as { port: number }).port;
  (ssh as unknown as { unref?: () => void }).unref?.();
});

afterAll(() => {
  // Closed without waiting, and the reason is measured: a socket this file opened on purpose and
  // never spoke on holds `close` open until its own timeout, so awaiting the callback makes the
  // teardown the slowest thing in the file and measures nothing. Both servers are unreferenced at
  // creation, so the process does not stay alive for them either way.
  (tcp as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  tcp.close();
  (ssh as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  ssh.close();
});

describe("the socket the provider opens is a real one", () => {
  test("a listening port answers with a connected socket", async () => {
    const socket = (await nodeSocketPort.connect({ host: "127.0.0.1", port: tcpPort, noDelay: true })) as Socket;
    expect(socket.remotePort).toBe(tcpPort);
    // The connect handler replaces its own error listener rather than removing it: a socket with no
    // 'error' listener throws in Node when one arrives, and ssh2 takes this socket from here.
    expect(socket.listenerCount("error")).toBe(1);
    socket.destroy();
  });

  test("a port nothing listens on rejects, and the socket is destroyed rather than left open", async () => {
    // Port 1 on loopback: privileged, unbound, and refused immediately on every platform this runs on.
    const attempt = nodeSocketPort.connect({ host: "127.0.0.1", port: 1, noDelay: true });
    await expect(attempt).rejects.toThrow();
  });

  test("a lookup the caller supplies is the lookup the socket uses", async () => {
    // The egress policy checks an address and hands the checked one over, so the address dialled has
    // to be the address checked. Node's own resolver is wrapped rather than replaced: a hand-written
    // one would measure this test's idea of the callback shape instead of the option being passed.
    let asked = 0;
    const socket = (await nodeSocketPort.connect({
      host: "localhost",
      port: tcpPort,
      noDelay: true,
      lookup: ((...args: Parameters<typeof dnsLookup>) => {
        asked += 1;
        return (dnsLookup as (...a: unknown[]) => unknown)(...args);
      }) as never,
    })) as Socket;
    expect(asked).toBe(1);
    expect(socket.remotePort).toBe(tcpPort);
    socket.destroy();
  });
});

describe("the SSH session the provider opens is a real handshake", () => {
  const dial = async () => {
    const sock = (await nodeSocketPort.connect({ host: "127.0.0.1", port: sshPort, noDelay: true })) as Socket;
    return nodeSshPort.connect({
      sock,
      username: USER,
      readyTimeout: 10_000,
      password: PASSWORD,
      hostVerifier: () => true,
    });
  };

  test("the handshake completes and the subsystem hands back a transport that carries the device's bytes", async () => {
    const session = await dial();
    await new Promise<void>((resolve) => session.onReady(resolve));
    const text = await new Promise<string>((resolve, reject) => {
      session.subsystem("netconf", (error, transport) => {
        if (error || transport === null) {
          reject(error ?? new Error("no transport"));
          return;
        }
        transport.onData((chunk) => resolve(chunk));
      });
    });
    expect(text).toContain("urn:ietf:params:xml:ns:netconf:base:1.0");
    session.end();
  });

  test("a subsystem the device refuses reaches the caller as an error rather than a null channel", async () => {
    const session = await dial();
    await new Promise<void>((resolve) => session.onReady(resolve));
    const failure = await new Promise<unknown>((resolve) => {
      session.subsystem("not-netconf", (error) => resolve(error));
    });
    expect(failure).toBeInstanceOf(Error);
    session.end();
  });

  test("the error handler stays attached after the first error, which is what a late handshake failure needs", async () => {
    // `on` rather than `once`, and the reason is measured in the source: a port that listens and
    // never speaks makes ssh2 raise a second error after the dial has already been answered, and a
    // one-shot listener leaves that one with nobody to take it.
    const sock = (await nodeSocketPort.connect({ host: "127.0.0.1", port: tcpPort, noDelay: true })) as Socket;
    const session = nodeSshPort.connect({
      sock,
      username: USER,
      readyTimeout: 300,
      password: PASSWORD,
      hostVerifier: () => true,
    });
    const first = await new Promise<unknown>((resolve) => session.onError(resolve));
    expect(first).toBeInstanceOf(Error);
    session.end();
  });
});

describe("the transport over a channel", () => {
  test("a character split across two chunks arrives whole", () => {
    // The decoder is the point of `transportOf`: `chunk.toString("utf8")` per segment would turn one
    // character into two replacement characters, and the reply would still parse.
    // U+00B5, the micro sign: two bytes, so a one-byte first chunk splits it.
    const bytes = Buffer.from("\u{00B5}", "utf8");
    let handler: ((chunk: Buffer) => void) | undefined;
    const channel = {
      write: () => true,
      on: (_e: "data", h: (chunk: Buffer) => void) => void (handler = h),
      once: () => true,
      end: () => true,
    };
    const client = { once: () => true, end: () => true };
    const seen: string[] = [];
    transportOf(channel, client).onData((text) => seen.push(text));
    handler?.(bytes.subarray(0, 1));
    handler?.(bytes.subarray(1));
    expect(seen.join("")).toBe("\u{00B5}");
  });
});
