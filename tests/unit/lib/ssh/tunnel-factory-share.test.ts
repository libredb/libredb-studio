import "../../../setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The real provider factory on the real tunnel pool, with `ssh2` and the loopback listener faked as
 * `tunnel-pool-route.test.ts` fakes them, for connects of one connection that share one forward.
 *
 * Concurrent connects of one forward are handed one forward, so whether a connect whose provider fails
 * may close it is no longer a question about that one call: a sibling may be connecting through the same
 * forward, or already serving through it. The forward closes on a failed connect only when no other
 * caller is still connecting through it and no provider opened on it.
 *
 * SQLite stands in for the provider because it ignores the rewritten host and port, so it connects
 * without a database server, and a NUL byte in its path makes its connect fail deterministically.
 */

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

class MockSSHClient extends EventEmitter {
  ended = false;

  connect() {
    setTimeout(() => this.emit("ready"), 5);
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

/** Every SSH client the pool asked for, in order. */
const clients: MockSSHClient[] = [];

mock.module("ssh2", () => ({
  Client: class {
    constructor() {
      const client = new MockSSHClient();
      clients.push(client);
      return client;
    }
  },
}));

let nextLocalPort = 46001;

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

/** Every loopback listener the pool opened, in order. */
const servers: MockServer[] = [];

const realNet = { ...(await import("net")) } as Record<string, unknown>;
const createServer = () => {
  const server = new MockServer();
  servers.push(server);
  return server;
};
mock.module("net", () => ({ ...realNet, default: { ...(realNet.default as object), createServer }, createServer }));

const { getOrCreateProvider, removeProvider } = await import("@/lib/db/factory");

const FIXTURE = "tunnel-share-fixture";

let connectionId = "";
let sequence = 0;

afterEach(async () => {
  await removeProvider(connectionId);
  clients.length = 0;
  servers.length = 0;
});

function record(database: string): DatabaseConnection {
  return {
    id: connectionId,
    name: "tunnel share",
    type: "sqlite",
    host: "db.internal",
    port: 5432,
    database,
    createdAt: new Date(),
    sshTunnel: {
      enabled: true,
      host: "bastion.example.com",
      port: 22,
      username: "studio",
      authMethod: "password",
      password: FIXTURE,
    },
  };
}

/** A record whose provider opens. */
const opens = () => getOrCreateProvider(record(":memory:"), {}, { allowExternalFileAccess: true });
/** A record of the same connection and forward whose provider fails to connect. */
const fails = () => getOrCreateProvider(record("bad\u0000path.db"), {}, { allowExternalFileAccess: true });

/** The loopback listener the provider was rewritten to dial. */
const listenerOf = (provider: { config: { port?: number } }) =>
  servers.find((server) => server.port === provider.config.port);

describe("connects of one connection through one forward", () => {
  test.each([
    ["the connect that opens is asked for first", [opens, fails] as const],
    ["the connect that fails is asked for first", [fails, opens] as const],
  ])("a concurrent connect that fails leaves the forward open for the one that opened (%s)", async (_order, calls) => {
    connectionId = `tunnel-share-${sequence++}`;
    const results = await Promise.allSettled(calls.map((call) => call()));
    const opened = results.find((result) => result.status === "fulfilled");
    const failed = results.find((result) => result.status === "rejected");

    expect(opened).toBeDefined();
    expect(failed).toBeDefined();
    expect(clients).toHaveLength(1);
    const provider = (opened as PromiseFulfilledResult<{ config: { port?: number } }>).value;
    expect(listenerOf(provider)?.closed).toBe(false);
    expect(clients[0].ended).toBe(false);
  });

  test("a connect that fails after a provider opened on the forward leaves the forward open", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const provider = await opens();

    await expect(fails()).rejects.toThrow();

    expect(clients).toHaveLength(1);
    expect(listenerOf(provider)?.closed).toBe(false);
  });

  test("a forward every concurrent connect failed on is closed", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const results = await Promise.allSettled([fails(), fails()]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(clients).toHaveLength(1);
    expect(servers).toHaveLength(1);
    expect(servers[0].closed).toBe(true);
    expect(clients[0].ended).toBe(true);
  });

  test("closing the connection closes the forward its provider opened on", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const provider = await opens();

    await removeProvider(connectionId);

    expect(listenerOf(provider)?.closed).toBe(true);
    expect(clients[0].ended).toBe(true);
  });
});
