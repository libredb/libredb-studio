import "../../../setup";
import { mock, describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "events";
import type { SSHTunnelConfig } from "@/lib/types";

/**
 * A pooled forward is shared only by calls that pin the same bastion host key, or none.
 *
 * The pool key frames the connection's own pin (`hostKeyFingerprint`) beside the route, the far end
 * and the credential digest, so a call whose record pins a host key dials its own forward, and that
 * dial checks the pin. A call that pins the same key, or a call that pins none beside one that pinned
 * none, is handed the pooled forward as before.
 *
 * This file mocks `ssh2` and `net` only, so what it drives is the real pool and the real verifier.
 */

/**
 * The host key the fake bastion offers and the fingerprint `ssh-keygen -lf` prints for it, taken from
 * `tests/unit/ssh-tunnel.test.ts` (a throwaway ed25519 key whose private half was never kept), and the
 * fingerprint of a second such key, which this bastion never offers.
 */
const OFFERED_HOST_KEY = Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIAeWh7W0w/sZuTB3QNIxyLeU/h53RIRJadA4iQcF/YPG", "base64");
const OFFERED_FINGERPRINT = "SHA256:JvC53Gq2xdb+Oi2SId63klTWrE0XS4CrLWqTgOC7B9Y";
const OTHER_FINGERPRINT = "SHA256:HNXfCNN9oifxQTL0zxPKCgu0TYROxoRatYNEXsmJUkc";

const PHRASE = crypto.randomUUID();

/** How many SSH clients the pool dialled, one per forward it opened or tried to open. */
let dials = 0;

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

class MockSSHClient extends EventEmitter {
  connect(opts: Record<string, unknown>) {
    dials += 1;
    // ssh2 calls the verifier with the raw host key during key exchange, and a false return fails the
    // handshake with this error (node_modules/ssh2/lib/protocol/kex.js).
    const verifier = opts.hostVerifier as (key: Buffer) => boolean;
    if (!verifier(OFFERED_HOST_KEY)) {
      setTimeout(() => this.emit("error", new Error("Host denied (verification failed)")), 0);
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

  end() {}
}

mock.module("ssh2", () => ({
  Client: class {
    constructor() {
      return new MockSSHClient();
    }
  },
}));

let nextLocalPort = 48001;

class MockServer extends EventEmitter {
  closed = false;
  readonly port = nextLocalPort++;

  listen(_port: number, _host: string, cb: () => void) {
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

const { createSSHTunnel, closeSSHTunnel, clearSSHHostKeyPin, getTunnelInfo } = await import("@/lib/ssh/tunnel");

const UNPINNED: SSHTunnelConfig = {
  enabled: true,
  host: "pinned-pool-bastion.example.com",
  port: 22,
  username: "admin",
  authMethod: "password",
  password: PHRASE,
};

const FAR_END = { host: "db.internal", port: 5432 };

let openIds: string[] = [];

const open = async (connectionId: string, ssh: SSHTunnelConfig) => {
  openIds.push(connectionId);
  return createSSHTunnel(connectionId, ssh, FAR_END.host, FAR_END.port);
};

describe("a pooled SSH forward is shared only by calls that pin the same bastion host key", () => {
  afterEach(async () => {
    await Promise.all([...new Set(openIds)].map((id) => closeSSHTunnel(id)));
    openIds = [];
    dials = 0;
    clearSSHHostKeyPin(UNPINNED.host, UNPINNED.port);
  });

  test("two calls with no pin share the forward", async () => {
    const connId = "host-key-unpinned-" + Date.now();

    const first = await open(connId, UNPINNED);
    const again = await open(connId, { ...UNPINNED });

    expect(again).toBe(first);
    expect(dials).toBe(1);
  });

  test("a call that pins another host key dials its own forward, and that dial refuses the bastion's key", async () => {
    const connId = "host-key-other-pin-" + Date.now();

    const first = await open(connId, UNPINNED);
    let refusal: unknown = null;
    try {
      await open(connId, { ...UNPINNED, hostKeyFingerprint: OTHER_FINGERPRINT });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toStartWith(
      `SSH host key verification failed for ${UNPINNED.host}:22: offered ${OFFERED_FINGERPRINT}, expected ${OTHER_FINGERPRINT}.`,
    );
    expect(dials).toBe(2);
    // The unpinned forward is untouched by the refusal.
    expect(getTunnelInfo(connId, { ssh: UNPINNED, farEnd: FAR_END })).toBe(first);
  });

  test("a call that pins the offered host key dials its own forward, and a second call with that pin shares it", async () => {
    const connId = "host-key-same-pin-" + Date.now();
    const pinned = { ...UNPINNED, hostKeyFingerprint: OFFERED_FINGERPRINT };

    const unpinned = await open(connId, UNPINNED);
    const first = await open(connId, pinned);
    const again = await open(connId, { ...pinned });

    expect(first).not.toBe(unpinned);
    expect(first.hostKeyFingerprint).toBe(OFFERED_FINGERPRINT);
    expect(again).toBe(first);
    expect(dials).toBe(2);
  });
});
