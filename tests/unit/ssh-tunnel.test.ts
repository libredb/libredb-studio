import "../setup";
import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { SSHTunnelConfig } from "@/lib/types";
import { logger } from "@/lib/logger";

// --- Mock ssh2 Client ---
// CI rests on this mock's FIDELITY to ssh2, and nothing here measures it. The handshake
// ordering, the `hostVerifier` contract and the refusal message below were derived by
// reading ssh2's own source - `node_modules/ssh2/lib/protocol/kex.js` and
// `lib/client.js` - so an ssh2 upgrade that changes any of them leaves this suite green
// while the product regresses. The live arm exists but does not stand: the three arms
// (no pin, correct pin, wrong pin) were driven once by hand on 2026-08-26 against a real
// `openssh-server` on port 2226, recorded in `docs/providers/README.md`; there is no sshd
// container fixture, so that is a one-time observation rather than a property the suite holds.
class MockSSHClient extends EventEmitter {
  connectOptions: Record<string, unknown> | null = null;
  forwardOutCalls: Array<{ bindAddr: string; bindPort: number; host: string; port: number }> = [];
  ended = false;
  /** What the tunnel last passed to `setNoDelay`, or undefined when it never called it. */
  noDelay: boolean | undefined = undefined;

  connect(opts: Record<string, unknown>) {
    this.connectOptions = opts;
    // ssh2 emits 'connect' once its TCP socket is up, before key exchange
    // (node_modules/ssh2/lib/client.js, the socket's own 'connect' handler).
    setTimeout(() => this.emit("connect"), 0);
    if (sessionEndsBeforeReady) {
      // A bastion that closes the TCP connection with a FIN before the handshake completes: ssh2
      // reports 'end' and 'close' and no 'error' (node_modules/ssh2/lib/client.js, the socket's
      // own 'end' and 'close' handlers).
      setTimeout(() => {
        this.emit("end");
        this.emit("close");
      }, 0);
      return;
    }
    // Mirror ssh2's own handshake ordering: the verifier is called with the raw K_S blob
    // during key exchange, and returning false fails the handshake with exactly this
    // error (node_modules/ssh2/lib/protocol/kex.js: "Host denied (verification failed)").
    const verifier = opts.hostVerifier as ((key: Buffer) => boolean) | undefined;
    if (verifier && serverHostKey && verifier(serverHostKey) === false) {
      setTimeout(() => this.emit("error", new Error("Host denied (verification failed)")), 0);
      return;
    }
    // Emit 'ready' asynchronously by default
    setTimeout(() => this.emit("ready"), 0);
  }

  forwardOut(
    bindAddr: string,
    bindPort: number,
    host: string,
    port: number,
    cb: (err: Error | null, stream: unknown) => void,
  ) {
    this.forwardOutCalls.push({ bindAddr, bindPort, host, port });
    // Return a mock duplex stream
    const mockStream = new MockDuplexStream();
    cb(null, mockStream);
  }

  setNoDelay(noDelay: boolean) {
    this.noDelay = noDelay;
    return this;
  }

  end() {
    this.ended = true;
  }
}

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

/**
 * Two REAL ed25519 host keys and the fingerprints `ssh-keygen -lf` prints for them.
 *
 * Measured, not hand-written: both pairs were produced by `ssh-keygen -t ed25519` and the
 * expected strings are verbatim `ssh-keygen -lf <key>.pub` output, so a test asserting them
 * is asserting OpenSSH's presentation rather than this repo's opinion of it. The blobs are
 * the base64 payload of the `.pub` line, which is byte-for-byte the K_S blob ssh2 hands
 * `hostVerifier`. Throwaway keys; the private halves were never kept.
 */
const HOST_KEY_A = Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIAeWh7W0w/sZuTB3QNIxyLeU/h53RIRJadA4iQcF/YPG", "base64");
const FINGERPRINT_A = "SHA256:JvC53Gq2xdb+Oi2SId63klTWrE0XS4CrLWqTgOC7B9Y";
const HOST_KEY_B = Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIKLxkWQNUtej2qCJ5kKne53rt00hhrfaws96zdHSB2rw", "base64");
const FINGERPRINT_B = "SHA256:HNXfCNN9oifxQTL0zxPKCgu0TYROxoRatYNEXsmJUkc";

/** Which host key the fake bastion offers on the next connect. */
let serverHostKey: Buffer | null = null;

/** Whether the fake bastion ends the next session before the handshake completes. */
let sessionEndsBeforeReady = false;

let mockSSHInstance: MockSSHClient;

mock.module("ssh2", () => ({
  Client: class {
    constructor() {
      mockSSHInstance = new MockSSHClient();
      return mockSSHInstance;
    }
  },
}));

// --- Mock net module ---
class MockServer extends EventEmitter {
  listenPort: number | null = null;
  listenHost: string | null = null;
  connectionHandler: ((socket: unknown) => void) | null = null;
  closed = false;

  constructor(handler: (socket: unknown) => void) {
    super();
    this.connectionHandler = handler;
  }

  listen(port: number, host: string, cb: () => void) {
    this.listenPort = port;
    this.listenHost = host;
    setTimeout(cb, 0);
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: 54321 };
  }

  close() {
    this.closed = true;
  }
}

let mockServerInstance: MockServer;

mock.module("net", () => ({
  default: {
    createServer: (handler: (socket: unknown) => void) => {
      mockServerInstance = new MockServer(handler);
      return mockServerInstance;
    },
  },
  createServer: (handler: (socket: unknown) => void) => {
    mockServerInstance = new MockServer(handler);
    return mockServerInstance;
  },
}));

// Dynamic import after mocks
const { createSSHTunnel, closeSSHTunnel, hasTunnel, getTunnelInfo, clearSSHHostKeyPin } = await import(
  "@/lib/ssh/tunnel"
);

const BASTION: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.example.com",
  port: 22,
  username: "admin",
  authMethod: "password",
  password: "pass",
};

// We need to clear the activeTunnels map between tests.
// Since it's a module-level Map, we close tunnels in afterEach.
let lastConnectionId: string | null = null;

describe("SSH Tunnel", () => {
  beforeEach(() => {
    lastConnectionId = null;
    serverHostKey = HOST_KEY_A;
    sessionEndsBeforeReady = false;
  });

  afterEach(async () => {
    // Clean up any active tunnel
    if (lastConnectionId && hasTunnel(lastConnectionId)) {
      await closeSSHTunnel(lastConnectionId);
    }
  });

  describe("createSSHTunnel", () => {
    test("creates tunnel with password auth", async () => {
      const connId = "test-pw-" + Date.now();
      lastConnectionId = connId;

      const tunnel = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "secret123",
        },
        "db.internal",
        5432,
      );

      expect(tunnel.localHost).toBe("127.0.0.1");
      expect(tunnel.localPort).toBe(54321);
      expect(typeof tunnel.close).toBe("function");

      // Verify SSH connect options
      expect(mockSSHInstance.connectOptions).toEqual({
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        password: "secret123",
        hostVerifier: expect.any(Function),
      });
    });

    test("disables Nagle on the bastion socket once it connects", async () => {
      // ssh2 1.17.0 never calls setNoDelay on the socket it dials. Under Node that put the
      // 40 ms delayed-ACK stall on every small query through the tunnel: measured through
      // Studio's query API against PostgreSQL behind OpenSSH, a SELECT 1 took a median
      // 46 ms tunnelled against 3 ms direct.
      const connId = "test-nodelay-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(connId, BASTION, "db.internal", 5432);

      expect(mockSSHInstance.noDelay).toBe(true);
    });

    test("creates tunnel with privateKey auth", async () => {
      const connId = "test-pk-" + Date.now();
      lastConnectionId = connId;

      const tunnel = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 2222,
          username: "deploy",
          authMethod: "privateKey",
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
          passphrase: "keypass",
        },
        "db.internal",
        3306,
      );

      expect(tunnel.localHost).toBe("127.0.0.1");
      expect(tunnel.localPort).toBe(54321);
      expect(mockSSHInstance.connectOptions).toEqual({
        host: "bastion.example.com",
        port: 2222,
        username: "deploy",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
        passphrase: "keypass",
        hostVerifier: expect.any(Function),
      });
    });

    test("creates tunnel with privateKey without passphrase", async () => {
      const connId = "test-pk-nopw-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "deploy",
          authMethod: "privateKey",
          privateKey: "fake-key",
        },
        "db.internal",
        5432,
      );

      expect(mockSSHInstance.connectOptions).toEqual({
        host: "bastion.example.com",
        port: 22,
        username: "deploy",
        privateKey: "fake-key",
        hostVerifier: expect.any(Function),
      });
      // No passphrase key present
      expect("passphrase" in (mockSSHInstance.connectOptions || {})).toBe(false);
    });

    test("uses default port 22 when not specified", async () => {
      const connId = "test-defport-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 0, // falsy → should default to 22
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      expect((mockSSHInstance.connectOptions as Record<string, unknown>)?.port).toBe(22);
    });

    // A pooled tunnel is keyed by the connection id AND the forward it was opened for -
    // bastion route and far end (D86). Keyed by the id alone, the second provider on a live
    // id was handed the forward the first one opened, whatever address it asked for, and
    // nothing in `TunnelInfo` let the caller notice. The route half is driven in
    // `tests/unit/lib/ssh/tunnel-pool-route.test.ts`.
    test("returns the existing tunnel for the same connection id and the same far end", async () => {
      const connId = "test-cache-" + Date.now();
      lastConnectionId = connId;

      const tunnel1 = await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      const tunnel2 = await createSSHTunnel(connId, BASTION, "db.internal", 5432);

      expect(tunnel2).toBe(tunnel1);
      expect(tunnel2.localPort).toBe(tunnel1.localPort);
    });

    test("does not serve a pooled tunnel when the caller asks for a different far end", async () => {
      const connId = "test-cache-other-far-end-" + Date.now();
      lastConnectionId = connId;

      const first = await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      const second = await createSSHTunnel(connId, BASTION, "other-db.internal", 3306);

      expect(second).not.toBe(first);
      expect(first.remoteHost).toBe("db.internal");
      expect(first.remotePort).toBe(5432);
      expect(second.remoteHost).toBe("other-db.internal");
      expect(second.remotePort).toBe(3306);
      // Both are pooled under the one id, and asking for either far end answers its own.
      expect(getTunnelInfo(connId, { ssh: BASTION, farEnd: { host: "db.internal", port: 5432 } })).toBe(first);
      expect(getTunnelInfo(connId, { ssh: BASTION, farEnd: { host: "other-db.internal", port: 3306 } })).toBe(second);
      expect(hasTunnel(connId, { ssh: BASTION, farEnd: { host: "db.internal", port: 5432 } })).toBe(true);
      expect(hasTunnel(connId, { ssh: BASTION, farEnd: { host: "third-db.internal", port: 5432 } })).toBe(false);
    });

    test("closing a connection id closes every far end pooled under it", async () => {
      const connId = "test-close-all-far-ends-" + Date.now();

      await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      await createSSHTunnel(connId, BASTION, "other-db.internal", 3306);
      expect(hasTunnel(connId)).toBe(true);

      await closeSSHTunnel(connId);

      expect(hasTunnel(connId)).toBe(false);
      expect(hasTunnel(connId, { ssh: BASTION, farEnd: { host: "db.internal", port: 5432 } })).toBe(false);
      expect(hasTunnel(connId, { ssh: BASTION, farEnd: { host: "other-db.internal", port: 3306 } })).toBe(false);
    });

    // A one-shot tunnel (`shared: false`) is the transport for the routes that build a
    // provider outside the caches - test-connection and schema-snapshot. Those carry a
    // connection id that is thrown away (the connection dialog mints a fresh one per
    // build), so a cached tunnel under that id would never be evicted by anything:
    // `removeProvider` and the idle sweep only close tunnels of CACHED providers. Hence
    // the three invariants below - never read the cache, never write it, and never let
    // closing an unshared tunnel evict the shared entry that happens to share its id.
    test("does not reuse the shared tunnel when shared is false", async () => {
      const connId = "test-oneshot-nocache-" + Date.now();
      lastConnectionId = connId;

      const shared = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      const oneShot = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
        { shared: false },
      );

      expect(oneShot).not.toBe(shared);
    });

    test("does not register a one-shot tunnel in the active map", async () => {
      const connId = "test-oneshot-unregistered-" + Date.now();

      const oneShot = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
        { shared: false },
      );

      expect(hasTunnel(connId)).toBe(false);
      expect(getTunnelInfo(connId)).toBeUndefined();

      await oneShot.close();
    });

    test("closing a one-shot tunnel leaves the shared tunnel of the same id registered", async () => {
      const connId = "test-oneshot-noevict-" + Date.now();
      lastConnectionId = connId;

      const shared = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      const oneShot = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
        { shared: false },
      );
      await oneShot.close();

      expect(hasTunnel(connId)).toBe(true);
      expect(getTunnelInfo(connId)).toBe(shared);
    });

    test("rejects on SSH connection error", async () => {
      const connId = "test-ssherr-" + Date.now();
      lastConnectionId = connId;

      const promise = createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bad-host.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      // Emit error on the SSH client after connect is called
      // The mock emits 'ready' via setTimeout, so we emit 'error' immediately
      mockSSHInstance.removeAllListeners("ready");
      setTimeout(() => mockSSHInstance.emit("error", new Error("Connection refused")), 5);

      await expect(promise).rejects.toThrow("SSH connection error: Connection refused");
      // Tunnel should be cleaned up
      expect(hasTunnel(connId)).toBe(false);
    });

    test("rejects on local server error", async () => {
      const connId = "test-serverr-" + Date.now();
      lastConnectionId = connId;

      // Intercept createServer to make the server emit error before listen callback fires
      const originalListen = MockServer.prototype.listen;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      MockServer.prototype.listen = function (this: MockServer, _port: number, _host: string, _cb: () => void) {
        // Don't call the callback — instead emit error
        setTimeout(() => this.emit("error", new Error("EADDRINUSE")), 0);
      };

      const promise = createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      await expect(promise).rejects.toThrow("SSH tunnel local server error: EADDRINUSE");
      expect(hasTunnel(connId)).toBe(false);

      // Restore
      MockServer.prototype.listen = originalListen;
    });

    test("local server listen binds to 127.0.0.1 on random port", async () => {
      const connId = "test-listen-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      expect(mockServerInstance.listenPort).toBe(0); // 0 = random available port
      expect(mockServerInstance.listenHost).toBe("127.0.0.1");
    });

    test("forwards socket connections through SSH", async () => {
      const connId = "test-fwd-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      // Simulate incoming connection to local server
      const mockSocket = new MockDuplexStream();
      (mockSocket as unknown as { end: () => void }).end = () => {};
      mockServerInstance.connectionHandler!(mockSocket);

      expect(mockSSHInstance.forwardOutCalls.length).toBe(1);
      expect(mockSSHInstance.forwardOutCalls[0]).toEqual({
        bindAddr: "127.0.0.1",
        bindPort: 0,
        host: "db.internal",
        port: 5432,
      });
    });

    test("destroys the local socket with the bastion's refusal and logs it once", async () => {
      const connId = "test-fwderr-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      // Make the SSH forward fail for the next incoming socket
      mockSSHInstance.forwardOut = (
        _bindAddr: string,
        _bindPort: number,
        _host: string,
        _port: number,
        cb: (err: Error | null, stream: unknown) => void,
      ) => {
        cb(new Error("(SSH) Channel open failure: Connection refused"), null);
      };

      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const mockSocket = new MockDuplexStream();
        const destroyedWith: unknown[] = [];
        (mockSocket as unknown as { destroy: (error?: Error) => void }).destroy = (error?: Error) => {
          destroyedWith.push(error);
          // net.Socket#destroy(error) emits the error on the socket, which is why its listener comes first.
          if (error) mockSocket.emit("error", error);
        };
        mockServerInstance.connectionHandler!(mockSocket);

        expect(destroyedWith).toHaveLength(1);
        expect(String(destroyedWith[0])).toContain("Channel open failure: Connection refused");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("db.internal:5432");
        expect(String(warn.mock.calls[0][0])).toContain("Channel open failure: Connection refused");
      } finally {
        warn.mockRestore();
      }
    });

    test("a forwardOut that throws destroys that socket with the error instead of throwing out of the handler", async () => {
      const connId = "test-fwdthrow-" + Date.now();
      lastConnectionId = connId;
      await createSSHTunnel(connId, BASTION, "db.internal", 5432);

      // What ssh2 1.17.0 does when its socket is no longer writable (node_modules/ssh2/lib/client.js, forwardOut).
      mockSSHInstance.forwardOut = () => {
        throw new Error("Not connected");
      };

      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const mockSocket = new MockDuplexStream();
        const destroyedWith: unknown[] = [];
        (mockSocket as unknown as { destroy: (error?: Error) => void }).destroy = (error?: Error) => {
          destroyedWith.push(error);
          if (error) mockSocket.emit("error", error);
        };

        expect(() => mockServerInstance.connectionHandler!(mockSocket)).not.toThrow();
        expect(destroyedWith.map(String)).toEqual(["Error: Not connected"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("Not connected");
      } finally {
        warn.mockRestore();
      }
    });

    test("a loopback socket that fails while its channel open is pending is handled on that socket", async () => {
      const connId = "test-pending-" + Date.now();
      lastConnectionId = connId;
      await createSSHTunnel(connId, BASTION, "db.internal", 5432);

      // The bastion has not answered the channel open yet, so the callback has not run.
      mockSSHInstance.forwardOut = () => mockSSHInstance;

      const mockSocket = new MockDuplexStream();
      mockServerInstance.connectionHandler!(mockSocket);

      // An EventEmitter with no 'error' listener throws what it is handed, as a net.Socket does.
      expect(() => mockSocket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    });

    test("destroys the socket on stream error and closes the stream on socket error", async () => {
      const connId = "test-streamerr-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      // Capture the forwarded stream so its error handlers can be exercised
      const streams: MockDuplexStream[] = [];
      let streamClosed = false;
      mockSSHInstance.forwardOut = (
        _bindAddr: string,
        _bindPort: number,
        _host: string,
        _port: number,
        cb: (err: Error | null, stream: unknown) => void,
      ) => {
        const stream = new MockDuplexStream();
        (stream as unknown as { close: () => void }).close = () => {
          streamClosed = true;
        };
        streams.push(stream);
        cb(null, stream);
      };

      const mockSocket = new MockDuplexStream();
      let destroyed = false;
      (mockSocket as unknown as { end: () => void }).end = () => {};
      (mockSocket as unknown as { destroy: () => void }).destroy = () => {
        destroyed = true;
      };
      mockServerInstance.connectionHandler!(mockSocket);
      expect(streams.length).toBe(1);

      streams[0].emit("error", new Error("stream broke"));
      expect(destroyed).toBe(true);

      mockSocket.emit("error", new Error("socket broke"));
      expect(streamClosed).toBe(true);
    });
  });

  describe("the SSH session ending", () => {
    test.each(["end", "close"])(
      "ssh2 '%s' takes the forward out of the pool, closes its loopback listener and logs the loss once",
      async (event) => {
        const connId = `test-session-${event}-` + Date.now();
        lastConnectionId = connId;
        await createSSHTunnel(connId, BASTION, "db.internal", 5432);
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          mockSSHInstance.emit(event);
          // ssh2 follows 'end' with 'close'; the second one finds the tunnel already gone.
          mockSSHInstance.emit("close");

          expect(hasTunnel(connId)).toBe(false);
          expect(mockServerInstance.closed).toBe(true);
          expect(mockSSHInstance.ended).toBe(true);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0][0])).toContain(connId);
          expect(String(warn.mock.calls[0][0])).toContain("the bastion ended the SSH session");
        } finally {
          warn.mockRestore();
        }
      },
    );

    test("an SSH error after the tunnel is open logs the loss once, naming the error", async () => {
      const connId = "test-session-error-" + Date.now();
      lastConnectionId = connId;
      await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        mockSSHInstance.emit("error", new Error("read ECONNRESET"));
        mockSSHInstance.emit("close");

        expect(hasTunnel(connId)).toBe(false);
        expect(mockServerInstance.closed).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("read ECONNRESET");
      } finally {
        warn.mockRestore();
      }
    });

    test("a tunnel its owner closed logs no loss when ssh2 then reports the session's end", async () => {
      const connId = "test-session-owner-" + Date.now();
      const tunnel = await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await tunnel.close();
        mockSSHInstance.emit("end");
        mockSSHInstance.emit("close");

        expect(hasTunnel(connId)).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    test("a late session end does not take a newer forward of the same key out of the pool", async () => {
      const connId = "test-session-late-" + Date.now();
      lastConnectionId = connId;
      const first = await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      const firstClient = mockSSHInstance;
      await first.close();

      const second = await createSSHTunnel(connId, BASTION, "db.internal", 5432);
      firstClient.emit("close");

      expect(getTunnelInfo(connId)).toBe(second);
    });

    test("a session that ends before the handshake completes rejects naming the bastion", async () => {
      sessionEndsBeforeReady = true;
      const connId = "test-session-early-" + Date.now();

      // Raced against a timer so the defect this pins, a promise that never settles, fails the test by name.
      const unsettled = new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("createSSHTunnel did not settle")), 1000),
      );
      await expect(Promise.race([createSSHTunnel(connId, BASTION, "db.internal", 5432), unsettled])).rejects.toThrow(
        "SSH connection to bastion.example.com:22 closed before the tunnel was ready",
      );
      expect(hasTunnel(connId)).toBe(false);
    });
  });

  describe("closeSSHTunnel", () => {
    test("closes an active tunnel", async () => {
      const connId = "test-close-" + Date.now();

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      expect(hasTunnel(connId)).toBe(true);

      await closeSSHTunnel(connId);

      expect(hasTunnel(connId)).toBe(false);
      expect(mockSSHInstance.ended).toBe(true);
      expect(mockServerInstance.closed).toBe(true);
    });

    test("does nothing for non-existent tunnel", async () => {
      // Should not throw
      await closeSSHTunnel("non-existent-id");
    });
  });

  describe("hasTunnel", () => {
    test("returns false for unknown connection", () => {
      expect(hasTunnel("unknown-id")).toBe(false);
    });

    test("returns true for active tunnel", async () => {
      const connId = "test-has-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      expect(hasTunnel(connId)).toBe(true);
    });
  });

  describe("getTunnelInfo", () => {
    test("returns undefined for unknown connection", () => {
      expect(getTunnelInfo("unknown-id")).toBeUndefined();
    });

    test("returns tunnel info for active tunnel", async () => {
      const connId = "test-info-" + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "pass",
        },
        "db.internal",
        5432,
      );

      const info = getTunnelInfo(connId);
      expect(info).toBeDefined();
      expect(info!.localHost).toBe("127.0.0.1");
      expect(info!.localPort).toBe(54321);
      expect(typeof info!.close).toBe("function");
    });
  });
});

/**
 * D11: before this, `connectOptions` carried no `hostVerifier` and ssh2 has no default -
 * `kex.js` logs "Host accepted by default (no verification)" and completes the handshake
 * against whatever answered. Every test below uses a bastion address of its own, because
 * the trust-on-first-use memory is keyed by bastion address and sharing one address would
 * make each test depend on another's first contact.
 */
describe("SSH host key verification", () => {
  const passwordAuth = { enabled: true as const, username: "admin", authMethod: "password" as const, password: "pass" };

  test("reports the fingerprint OpenSSH itself prints for the offered key", async () => {
    serverHostKey = HOST_KEY_B;

    const tunnel = await createSSHTunnel(
      "fp-format",
      { ...passwordAuth, host: "format-bastion.test", port: 22 },
      "db.internal",
      5432,
      { shared: false },
    );

    // Verbatim `ssh-keygen -lf` output for HOST_KEY_B: SHA256, base64, padding stripped.
    expect(tunnel.hostKeyFingerprint).toBe(FINGERPRINT_B);
    await tunnel.close();
  });

  test("first contact with no pin succeeds and pins the key it accepted", async () => {
    serverHostKey = HOST_KEY_A;

    const first = await createSSHTunnel(
      "tofu-first",
      { ...passwordAuth, host: "tofu-bastion.test", port: 22 },
      "db.internal",
      5432,
      { shared: false },
    );
    expect(first.hostKeyFingerprint).toBe(FINGERPRINT_A);
    await first.close();

    // The pin is only observable through its effect: a LATER contact with the same bastion
    // offering a different key must now be refused.
    serverHostKey = HOST_KEY_B;
    const later = createSSHTunnel(
      "tofu-later",
      { ...passwordAuth, host: "tofu-bastion.test", port: 22 },
      "db.internal",
      5432,
      { shared: false },
    );
    await expect(later).rejects.toThrow(FINGERPRINT_A);
  });

  test("a pinned connection offered the same key connects", async () => {
    serverHostKey = HOST_KEY_A;

    const tunnel = await createSSHTunnel(
      "pin-match",
      { ...passwordAuth, host: "match-bastion.test", port: 22, hostKeyFingerprint: FINGERPRINT_A },
      "db.internal",
      5432,
      { shared: false },
    );

    expect(tunnel.localPort).toBe(54321);
    expect(tunnel.hostKeyFingerprint).toBe(FINGERPRINT_A);
    await tunnel.close();
  });

  test("a pinned connection offered a different key fails naming both fingerprints", async () => {
    serverHostKey = HOST_KEY_B;

    const promise = createSSHTunnel(
      "pin-mismatch",
      { ...passwordAuth, host: "mismatch-bastion.test", port: 22, hostKeyFingerprint: FINGERPRINT_A },
      "db.internal",
      5432,
      { shared: false },
    );

    const error = await promise.then(
      () => null,
      (err: Error) => err,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("mismatch-bastion.test");
    expect(error!.message).toContain(FINGERPRINT_B); // what it saw
    expect(error!.message).toContain(FINGERPRINT_A); // what it expected
    expect(hasTunnel("pin-mismatch")).toBe(false);
  });

  test("clearing the pin lets the next contact be trusted afresh", async () => {
    serverHostKey = HOST_KEY_A;
    const first = await createSSHTunnel(
      "clear-first",
      { ...passwordAuth, host: "clear-bastion.test", port: 22 },
      "db.internal",
      5432,
      { shared: false },
    );
    await first.close();

    clearSSHHostKeyPin("clear-bastion.test", 22);

    serverHostKey = HOST_KEY_B;
    const second = await createSSHTunnel(
      "clear-second",
      { ...passwordAuth, host: "clear-bastion.test", port: 22 },
      "db.internal",
      5432,
      { shared: false },
    );
    expect(second.hostKeyFingerprint).toBe(FINGERPRINT_B);
    await second.close();
  });

  test("defaults the pin address to port 22 when the config leaves the port falsy", async () => {
    serverHostKey = HOST_KEY_A;
    const first = await createSSHTunnel(
      "defport-first",
      { ...passwordAuth, host: "defport-bastion.test", port: 0 },
      "db.internal",
      5432,
      { shared: false },
    );
    await first.close();

    // Pinned under :22, so clearing :22 is what un-pins it.
    clearSSHHostKeyPin("defport-bastion.test", 22);
    serverHostKey = HOST_KEY_B;
    const second = await createSSHTunnel(
      "defport-second",
      { ...passwordAuth, host: "defport-bastion.test", port: 0 },
      "db.internal",
      5432,
      { shared: false },
    );
    expect(second.hostKeyFingerprint).toBe(FINGERPRINT_B);
    await second.close();
  });
});
