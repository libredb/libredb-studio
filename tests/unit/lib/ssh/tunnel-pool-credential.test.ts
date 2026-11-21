import "../../../setup";
import { mock, describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "events";
import type { SSHTunnelConfig } from "@/lib/types";

/**
 * A pooled forward is shared only by calls that present the credential it was opened with.
 *
 * The pool key frames the connection id, the far end and the bastion route, and beside them a digest
 * of the tunnel credential the forward was opened with: the auth method, the password, the private
 * key and its passphrase. A call that presents another credential dials its own forward with it, and
 * a call that presents the same one is handed the pooled forward, or joins the dial under way, as
 * before.
 *
 * A rotated credential therefore opens a second forward. The forward opened with the old one is not
 * closed by the rotation: it ends as every pooled forward does, by the connection's own teardown
 * (`closeSSHTunnel`, which `removeProvider` and the idle sweep call), by the last release of a forward
 * no provider opened on, or by the end of its own SSH session.
 *
 * This file mocks `ssh2` and `net` only, so what it drives is the real pool.
 */

/** The phrase the fake bastion accepts, unless a test names another. */
const FIRST_PHRASE = "SEED-CANARY-1f6a";
const ROTATED_PHRASE = "SEED-CANARY-2b7c";
const REFUSED_PHRASE = "SEED-CANARY-3d8e";
const FIRST_PEM = "SEED-CANARY-pem-4e9f";
const OTHER_PEM = "SEED-CANARY-pem-5a0b";
const FIRST_UNLOCK = "SEED-CANARY-unlock-6c1d";
const OTHER_UNLOCK = "SEED-CANARY-unlock-7d2e";

/** What each SSH client the pool dialled presented, in order. */
const presented: Array<{ password?: unknown; privateKey?: unknown; passphrase?: unknown }> = [];

/** When set, the fake bastion refuses a password other than this one, as ssh2 reports the refusal. */
let acceptedPassword: string | null = null;

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

class MockSSHClient extends EventEmitter {
  ended = false;

  connect(opts: Record<string, unknown>) {
    presented.push({ password: opts.password, privateKey: opts.privateKey, passphrase: opts.passphrase });
    if (acceptedPassword !== null && opts.password !== acceptedPassword) {
      // ssh2's own wording when every offered method is refused (node_modules/ssh2/lib/client.js).
      setTimeout(() => this.emit("error", new Error("All configured authentication methods failed")), 0);
      return;
    }
    setTimeout(() => this.emit("ready"), 0);
  }

  forwardOut(
    _bindAddr: string,
    _bindPort: number,
    _host: string,
    _port: number,
    cb: (err: Error | null, stream: unknown) => void,
  ) {
    cb(null, new MockDuplexStream());
  }

  end() {
    this.ended = true;
  }
}

mock.module("ssh2", () => ({
  Client: class {
    constructor() {
      return new MockSSHClient();
    }
  },
}));

/** A distinct local port per forward, so two pooled entries are also distinguishable by address. */
let nextLocalPort = 47001;

/** Every loopback listener the pool opened, by its port, so a test can ask whether a forward was closed. */
const listeners = new Map<number, MockServer>();

class MockServer extends EventEmitter {
  closed = false;
  readonly port = nextLocalPort++;

  listen(_port: number, _host: string, cb: () => void) {
    listeners.set(this.port, this);
    setTimeout(cb, 0);
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close() {
    this.closed = true;
  }
}

const createServer = () => new MockServer();

mock.module("net", () => ({ default: { createServer }, createServer }));

const { createSSHTunnel, closeSSHTunnel, hasTunnel, getTunnelInfo, releaseUnopenedTunnel, tunnelProviderOpened } =
  await import("@/lib/ssh/tunnel");

const BY_PASSWORD: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.example.com",
  port: 22,
  username: "admin",
  authMethod: "password",
  password: FIRST_PHRASE,
};
const BY_PRIVATE_KEY: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.example.com",
  port: 22,
  username: "admin",
  authMethod: "privateKey",
  privateKey: FIRST_PEM,
  passphrase: FIRST_UNLOCK,
};

const FAR_END = { host: "db.internal", port: 5432 };

let openIds: string[] = [];

const open = async (connectionId: string, ssh: SSHTunnelConfig) => {
  openIds.push(connectionId);
  return createSSHTunnel(connectionId, ssh, FAR_END.host, FAR_END.port);
};

const closedPort = (port: number) => listeners.get(port)?.closed;

describe("a pooled SSH forward is shared only by calls that present the credential it was opened with", () => {
  afterEach(async () => {
    await Promise.all([...new Set(openIds)].map((id) => closeSSHTunnel(id)));
    openIds = [];
    presented.length = 0;
    acceptedPassword = null;
  });

  test("the same credential shares the forward", async () => {
    const connId = "credential-same-" + Date.now();

    const first = await open(connId, BY_PASSWORD);
    const again = await open(connId, { ...BY_PASSWORD });

    expect(again).toBe(first);
    expect(presented).toEqual([{ password: FIRST_PHRASE, privateKey: undefined, passphrase: undefined }]);
  });

  test("another password on the same id, route and far end dials its own forward with that password", async () => {
    const connId = "credential-password-" + Date.now();

    const first = await open(connId, BY_PASSWORD);
    const second = await open(connId, { ...BY_PASSWORD, password: ROTATED_PHRASE });

    expect(second).not.toBe(first);
    expect(second.localPort).not.toBe(first.localPort);
    expect(presented.map((dial) => dial.password)).toEqual([FIRST_PHRASE, ROTATED_PHRASE]);
  });

  test("another private key, another passphrase or another auth method dials its own forward", async () => {
    const connId = "credential-private-key-" + Date.now();

    const first = await open(connId, BY_PRIVATE_KEY);
    const otherPem = await open(connId, { ...BY_PRIVATE_KEY, privateKey: OTHER_PEM });
    const otherUnlock = await open(connId, { ...BY_PRIVATE_KEY, passphrase: OTHER_UNLOCK });
    const byPassword = await open(connId, { ...BY_PRIVATE_KEY, authMethod: "password", password: FIRST_PHRASE });
    const again = await open(connId, { ...BY_PRIVATE_KEY });

    expect(new Set([first, otherPem, otherUnlock, byPassword]).size).toBe(4);
    expect(again).toBe(first);
    expect(presented).toEqual([
      { password: undefined, privateKey: FIRST_PEM, passphrase: FIRST_UNLOCK },
      { password: undefined, privateKey: OTHER_PEM, passphrase: FIRST_UNLOCK },
      { password: undefined, privateKey: FIRST_PEM, passphrase: OTHER_UNLOCK },
      { password: FIRST_PHRASE, privateKey: undefined, passphrase: undefined },
    ]);
  });

  test("a dial with another credential that fails reports its own error and leaves the pooled forward open", async () => {
    const connId = "credential-refused-" + Date.now();
    acceptedPassword = FIRST_PHRASE;

    const first = await open(connId, BY_PASSWORD);
    let refusal: unknown = null;
    try {
      await open(connId, { ...BY_PASSWORD, password: REFUSED_PHRASE });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe("SSH connection error: All configured authentication methods failed");
    expect(presented.map((dial) => dial.password)).toEqual([FIRST_PHRASE, REFUSED_PHRASE]);
    // The forward opened with the accepted credential is untouched by the refusal.
    expect(getTunnelInfo(connId, { ssh: BY_PASSWORD, farEnd: FAR_END })).toBe(first);
    expect(closedPort(first.localPort)).toBe(false);
  });

  test("a call made while another credential's dial is under way dials its own", async () => {
    const connId = "credential-pending-" + Date.now();

    const [first, second] = await Promise.all([
      open(connId, BY_PASSWORD),
      open(connId, { ...BY_PASSWORD, password: ROTATED_PHRASE }),
    ]);

    expect(second).not.toBe(first);
    expect(presented.map((dial) => dial.password)).toEqual([FIRST_PHRASE, ROTATED_PHRASE]);
  });

  test("each credential's forward answers its own lookup, and a credential nothing was opened with answers none", async () => {
    const connId = "credential-lookup-" + Date.now();

    const first = await open(connId, BY_PASSWORD);
    const rotated = await open(connId, { ...BY_PASSWORD, password: ROTATED_PHRASE });

    expect(getTunnelInfo(connId, { ssh: BY_PASSWORD, farEnd: FAR_END })).toBe(first);
    expect(getTunnelInfo(connId, { ssh: { ...BY_PASSWORD, password: ROTATED_PHRASE }, farEnd: FAR_END })).toBe(rotated);
    expect(hasTunnel(connId, { ssh: { ...BY_PASSWORD, password: REFUSED_PHRASE }, farEnd: FAR_END })).toBe(false);
  });

  describe("a rotated credential", () => {
    test("leaves the forward opened with the old one serving, until the connection's teardown closes both", async () => {
      const connId = "credential-rotation-" + Date.now();

      const old = await open(connId, BY_PASSWORD);
      tunnelProviderOpened(old);
      const rotated = await open(connId, { ...BY_PASSWORD, password: ROTATED_PHRASE });
      tunnelProviderOpened(rotated);

      // Both forwards are open: the rotation opened a second one and closed nothing.
      expect(rotated).not.toBe(old);
      expect(closedPort(old.localPort)).toBe(false);
      expect(closedPort(rotated.localPort)).toBe(false);
      expect(getTunnelInfo(connId, { ssh: BY_PASSWORD, farEnd: FAR_END })).toBe(old);

      await closeSSHTunnel(connId);

      expect(closedPort(old.localPort)).toBe(true);
      expect(closedPort(rotated.localPort)).toBe(true);
      expect(hasTunnel(connId)).toBe(false);
    });

    test("closes the old forward on its last release when no provider opened on it, and keeps the new one", async () => {
      const connId = "credential-rotation-release-" + Date.now();

      const old = await open(connId, BY_PASSWORD);
      const rotated = await open(connId, { ...BY_PASSWORD, password: ROTATED_PHRASE });
      tunnelProviderOpened(rotated);

      await releaseUnopenedTunnel(old);

      expect(closedPort(old.localPort)).toBe(true);
      expect(hasTunnel(connId, { ssh: BY_PASSWORD, farEnd: FAR_END })).toBe(false);
      expect(closedPort(rotated.localPort)).toBe(false);
      expect(getTunnelInfo(connId, { ssh: { ...BY_PASSWORD, password: ROTATED_PHRASE }, farEnd: FAR_END })).toBe(
        rotated,
      );
    });
  });
});
