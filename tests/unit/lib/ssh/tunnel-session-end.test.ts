import "../../../setup";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { Server as SshServer, utils, type Connection, type ServerChannel } from "ssh2";
import { logger } from "@/lib/logger";
import type { SSHTunnelConfig } from "@/lib/types";
import { closeSSHTunnel, createSSHTunnel, hasTunnel } from "@/lib/ssh/tunnel";

/**
 * The pooled tunnel against a real `ssh2` bastion, for the ways an SSH session ends.
 *
 * `tests/unit/ssh-tunnel.test.ts` fakes `ssh2` and `net`, so it can only replay the events this
 * file's author believed ssh2 emits. Here nothing in the tunnel is stubbed: the bastion is ssh2's
 * own `Server` on loopback, the far end is an echo server, and every assertion is about what a
 * database driver dialling the loopback endpoint would meet.
 *
 * A session can end in three ways, and ssh2 1.17.0 reports them differently
 * (`node_modules/ssh2/lib/client.js`): a transport failure is `error`; a DISCONNECT with
 * BY_APPLICATION, and a TCP close with a FIN as when the bastion restarts, are `end` and `close`
 * only. The tunnel's cleanup ran on `error` alone, so the second kind left the forward pooled and its
 * loopback listener open, and the next connection to it asked a closed client for a channel.
 *
 * The same bastion also counts the sessions it is asked for, so concurrent calls for one tunnel can be
 * shown to share one SSH connection.
 */

/** How the bastion treats the next client: hold its channel opens pending, or close before the handshake. */
let bastionMode: "serve" | "hold-channels" | "close-before-handshake" = "serve";
const sessions: Connection[] = [];
/** The sessions whose connection has closed, as the bastion sees it. */
const closedSessions = new Set<Connection>();
/** The channel opens the bastion is holding, each confirmed when the test calls it. */
const heldChannels: Array<() => ServerChannel> = [];

let bastion: SshServer;
let bastionPort = 0;
let echo: net.Server;
let echoPort = 0;

beforeAll(async () => {
  echo = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = (echo.address() as net.AddressInfo).port;

  // ECDSA for the reason `tests/integration/db/netconf-node-ports.test.ts` measured: ssh2's own
  // ed25519 generator yields a key its own parser refuses a few times in a thousand.
  const key = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  bastion = new SshServer({ hostKeys: [key.private] }, (session) => {
    sessions.push(session);
    session.on("close", () => closedSessions.add(session));
    session.on("error", () => {});
    if (bastionMode === "close-before-handshake") {
      (session as unknown as { _sock: net.Socket })._sock.end();
      return;
    }
    session.on("authentication", (ctx) => ctx.accept());
    session.on("ready", () => {
      session.on("tcpip", (accept, _reject, info) => {
        if (bastionMode === "hold-channels") {
          heldChannels.push(accept);
          return;
        }
        const channel = accept();
        const upstream = net.connect(info.destPort, info.destIP);
        upstream.on("error", () => channel.close());
        channel.on("error", () => upstream.destroy());
        channel.pipe(upstream).pipe(channel);
      });
    });
  });
  await new Promise<void>((resolve) => bastion.listen(0, "127.0.0.1", resolve));
  bastionPort = (bastion.address() as net.AddressInfo).port;
});

afterAll(() => {
  for (const session of sessions) session.end();
  bastion.close();
  echo.close();
});

const openIds: string[] = [];

afterEach(async () => {
  bastionMode = "serve";
  await Promise.all(openIds.splice(0).map((id) => closeSSHTunnel(id)));
});

const bastionConfig = (): SSHTunnelConfig => ({
  enabled: true,
  host: "127.0.0.1",
  port: bastionPort,
  username: "studio",
  authMethod: "password",
  password: "fixture-password",
});

const open = (connectionId: string) => {
  openIds.push(connectionId);
  return createSSHTunnel(connectionId, bastionConfig(), "127.0.0.1", echoPort);
};

const forwardOf = () => ({ ssh: bastionConfig(), farEnd: { host: "127.0.0.1", port: echoPort } });

/** Waits for a condition the event loop has to deliver, failing by name after two seconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- a poll: each wait follows the check before it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** One round trip through the loopback endpoint, as a driver makes it: the bytes that came back, or the error. */
function roundTrip(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.on("connect", () => socket.write("ping"));
    socket.on("data", (chunk) => {
      received += chunk;
      if (received === "ping") {
        socket.destroy();
        resolve(`echoed ${received}`);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code}`));
    socket.on("close", () => resolve(`closed after ${JSON.stringify(received)}`));
  });
}

/** The bastion's side of the newest session. */
const lastSession = () => sessions[sessions.length - 1];

describe("a pooled tunnel whose SSH session the bastion ends", () => {
  test.each([
    ["sends DISCONNECT by application", (session: Connection) => session.end()],
    [
      "closes its TCP connection with a FIN",
      (session: Connection) => (session as unknown as { _sock: net.Socket })._sock.end(),
    ],
  ])("leaves the pool and closes its loopback listener when the bastion %s", async (_how, endSession) => {
    const connId = `session-end-${Date.now()}-${Math.random()}`;
    const warn = spyOn(logger, "warn");
    try {
      const tunnel = await open(connId);
      expect(await roundTrip(tunnel.localPort)).toBe("echoed ping");

      endSession(lastSession());
      await until("the forward to leave the pool", () => !hasTunnel(connId, forwardOf()));

      // The next dial is refused at the loopback endpoint, which a driver reports as a lost
      // connection, instead of reaching a listener whose SSH client is gone.
      expect(await roundTrip(tunnel.localPort)).toBe("error ECONNREFUSED");
      const lost = warn.mock.calls.filter(([message]) => String(message).includes("ended the SSH session"));
      expect(lost).toHaveLength(1);
      expect(String(lost[0][0])).toContain(connId);
    } finally {
      warn.mockRestore();
    }
  });

  test("the next request for that forward dials a new session", async () => {
    const connId = `session-end-redial-${Date.now()}`;
    const first = await open(connId);
    lastSession().end();
    await until("the forward to leave the pool", () => !hasTunnel(connId, forwardOf()));

    const second = await open(connId);
    expect(second).not.toBe(first);
    expect(await roundTrip(second.localPort)).toBe("echoed ping");
  });
});

describe("a tunnel whose bastion closes the connection before the handshake", () => {
  test("is refused by name instead of never settling", async () => {
    bastionMode = "close-before-handshake";
    const connId = `session-end-early-${Date.now()}`;
    // Raced against a timer so the defect this pins, a promise that never settles, fails the test by name.
    const unsettled = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("createSSHTunnel did not settle")), 2000),
    );
    await expect(Promise.race([open(connId), unsettled])).rejects.toThrow(
      `SSH connection to 127.0.0.1:${bastionPort} closed before the tunnel was ready`,
    );
    expect(hasTunnel(connId)).toBe(false);
  });
});

// Under Bun the reset alone passed before the fix as well: Bun does not raise the reset on an accepted socket
// with no 'error' listener, which Node does. The listener's order is held by `tests/unit/ssh-tunnel.test.ts`;
// this pins, against a real bastion, that the reset ends that one connection and not the tunnel, and that the
// channel the bastion confirms afterwards is closed rather than left open with nothing to end it.
describe("a loopback connection whose channel open is still pending", () => {
  test("a client that resets it closes that connection and its late channel, and the tunnel keeps serving", async () => {
    bastionMode = "hold-channels";
    const connId = `session-end-pending-${Date.now()}`;
    const tunnel = await open(connId);

    const socket = net.connect(tunnel.localPort, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("connect", resolve));
    // Long enough for the tunnel to have asked the bastion for the channel it is holding.
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(heldChannels).toHaveLength(1);
    const channel = heldChannels.splice(0)[0]();
    let channelClosed = false;
    channel.on("close", () => {
      channelClosed = true;
    });
    // A channel reports 'close' after its readable side ended, which needs it to be read.
    channel.resume();
    await until("the late channel to close", () => channelClosed);

    bastionMode = "serve";
    expect(hasTunnel(connId, forwardOf())).toBe(true);
  });
});

describe("concurrent calls for one tunnel", () => {
  test("share one SSH connection, and closing the connection closes it and its loopback listener", async () => {
    const connId = `session-share-${Date.now()}`;
    const before = sessions.length;

    const [first, second] = await Promise.all([open(connId), open(connId)]);

    expect(second).toBe(first);
    expect(sessions.length - before).toBe(1);
    expect(await roundTrip(first.localPort)).toBe("echoed ping");

    await closeSSHTunnel(connId);

    expect(hasTunnel(connId)).toBe(false);
    expect(await roundTrip(first.localPort)).toBe("error ECONNREFUSED");
    await until("the bastion to see every session of this tunnel close", () =>
      sessions.slice(before).every((session) => closedSessions.has(session)),
    );
  });

  test("a call made after the shared dial settled is handed the pooled forward", async () => {
    const connId = `session-share-later-${Date.now()}`;
    const before = sessions.length;
    const [first] = await Promise.all([open(connId), open(connId)]);

    const later = await open(connId);

    expect(later).toBe(first);
    expect(sessions.length - before).toBe(1);
  });

  test("a dial that fails rejects every caller waiting on it by name, and the next call dials again", async () => {
    bastionMode = "close-before-handshake";
    const connId = `session-share-failed-${Date.now()}`;
    const before = sessions.length;
    const refusal = `SSH connection to 127.0.0.1:${bastionPort} closed before the tunnel was ready`;

    const results = await Promise.allSettled([open(connId), open(connId)]);

    expect(results.map((result) => (result.status === "rejected" ? String(result.reason) : result.status))).toEqual([
      `Error: ${refusal}`,
      `Error: ${refusal}`,
    ]);
    expect(sessions.length - before).toBe(1);
    expect(hasTunnel(connId)).toBe(false);

    bastionMode = "serve";
    const next = await open(connId);
    expect(sessions.length - before).toBe(2);
    expect(await roundTrip(next.localPort)).toBe("echoed ping");
  });
});
