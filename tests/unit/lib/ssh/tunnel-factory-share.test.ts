import "../../../setup";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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
 *
 * Every order here is set by signals, never by a clock: the fake bastion answers only when a test tells
 * it to, the factory's calls into the pool are announced as they happen, and each record's provider can
 * be held at the start of its connect. Which connect dials, which one joins the dial or is served the
 * pooled forward, and which provider settles first are therefore the same on every run.
 */

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

class MockSSHClient extends EventEmitter {
  ended = false;

  /** The bastion answers when the test calls `bastionAnswers`. */
  connect() {}

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

/** The bastion of the one dial a test made answers, so the pool opens the forward. */
function bastionAnswers() {
  expect(clients).toHaveLength(1);
  clients[0].emit("ready");
}

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

/**
 * The real pool, with each call the factory makes for a forward announced once the pool has counted it
 * (as the dialler, a joiner of the dial under way, or a caller served the pooled forward).
 */
const realTunnel = await import("@/lib/ssh/tunnel");
// Taken before the mock below, which replaces the module's live binding of the same name.
const realCreateSSHTunnel = realTunnel.createSSHTunnel;
let asked = 0;
const askWaiters: { count: number; resolve: () => void }[] = [];
mock.module("@/lib/ssh/tunnel", () => ({
  ...realTunnel,
  createSSHTunnel: (...args: Parameters<typeof realCreateSSHTunnel>) => {
    const forward = realCreateSSHTunnel(...args);
    asked += 1;
    for (const waiter of askWaiters.filter((pending) => pending.count <= asked)) {
      askWaiters.splice(askWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return forward;
  },
}));

/** Resolves once the factory has asked the pool for a forward `count` times in this test. */
function askedFor(count: number): Promise<void> {
  if (asked >= count) return Promise.resolve();
  return new Promise((resolve) => askWaiters.push({ count, resolve }));
}

const { getOrCreateProvider, removeProvider } = await import("@/lib/db/factory");
const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");

/** A provider held at the start of its connect: `entered` says it got there, `release` lets it go on. */
interface HeldConnect {
  entered: Promise<void>;
  release: () => void;
}

/** The held connects, by the record's database path. A provider with no entry connects at once. */
const heldConnects = new Map<string, { enter: () => void; released: Promise<void> }>();

function holdConnect(database: string): HeldConnect {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldConnects.set(database, { enter, released });
  return { entered, release };
}

const realConnect = SQLiteProvider.prototype.connect;
spyOn(SQLiteProvider.prototype, "connect").mockImplementation(async function (
  this: InstanceType<typeof SQLiteProvider>,
) {
  const held = heldConnects.get(String(this.config.database));
  if (held) {
    held.enter();
    await held.released;
  }
  return realConnect.call(this);
});

const FIXTURE = "tunnel-share-fixture";

let connectionId = "";
let sequence = 0;

afterEach(async () => {
  await removeProvider(connectionId);
  clients.length = 0;
  servers.length = 0;
  asked = 0;
  askWaiters.length = 0;
  heldConnects.clear();
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

const OPENS = ":memory:";
const FAILS = "bad\u0000path.db";

/** A record whose provider opens. */
const opens = () => getOrCreateProvider(record(OPENS), {}, { allowExternalFileAccess: true });
/** A record of the same connection and forward whose provider fails to connect. */
const fails = () => getOrCreateProvider(record(FAILS), {}, { allowExternalFileAccess: true });

type Opened = { config: { port?: number } };
type Outcome = { status: "fulfilled"; value: Opened } | { status: "rejected"; reason: unknown };

/** How a connect ended, awaited without a matcher so the test decides what to check and when. */
const settled = (connect: Promise<Opened>): Promise<Outcome> =>
  connect.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );

/** The loopback listener the provider was rewritten to dial. */
const listenerOf = (provider: Opened) => servers.find((server) => server.port === provider.config.port);

/** Runs a connect that dials the forward, answering its dial once the pool asked for it. */
async function dialledAlone(connect: () => Promise<Opened>): Promise<Opened> {
  const result = connect();
  await askedFor(asked + 1);
  bastionAnswers();
  return result;
}

describe("connects of one connection through one forward", () => {
  test.each([
    ["the connect that fails dials, and the one that joined the dial opens", "fails"],
    ["the connect that opens dials, and the one that joined the dial fails", "opens"],
  ])(
    "a concurrent connect that fails while the other is still connecting leaves the forward open (%s)",
    async (_order, dialler) => {
      connectionId = `tunnel-share-${sequence++}`;
      const failing = holdConnect(FAILS);
      const opening = holdConnect(OPENS);
      const [first, second] = dialler === "fails" ? [fails, opens] : [opens, fails];

      const firstOutcome = settled(first());
      await askedFor(1);
      const secondOutcome = settled(second());
      await askedFor(2);
      // Both are counted on the one dial before the bastion answers.
      bastionAnswers();
      await Promise.all([failing.entered, opening.entered]);

      failing.release();
      const failed = await (dialler === "fails" ? firstOutcome : secondOutcome);
      expect(failed.status).toBe("rejected");
      expect(servers).toHaveLength(1);
      expect(servers[0].closed).toBe(false);
      expect(clients[0].ended).toBe(false);

      opening.release();
      const opened = await (dialler === "fails" ? secondOutcome : firstOutcome);
      expect(opened.status).toBe("fulfilled");
      expect(clients).toHaveLength(1);
      expect(listenerOf((opened as { value: Opened }).value)?.closed).toBe(false);
    },
  );

  test.each([
    ["the connect that dialled fails, and the one served the pooled forward opens", "fails"],
    ["the connect that dialled opens, and the one served the pooled forward fails", "opens"],
  ])(
    "a connect served the pooled forward while the dialling connect is still opening keeps it open (%s)",
    async (_order, dialler) => {
      connectionId = `tunnel-share-${sequence++}`;
      const failing = holdConnect(FAILS);
      const opening = holdConnect(OPENS);
      const [first, second] = dialler === "fails" ? [fails, opens] : [opens, fails];
      const [firstHeld, secondHeld] = dialler === "fails" ? [failing, opening] : [opening, failing];

      const firstOutcome = settled(dialledAlone(first));
      // The dial settled and the forward is pooled; the dialling connect's provider is still connecting.
      await firstHeld.entered;
      const secondOutcome = settled(second());
      await secondHeld.entered;
      expect(clients).toHaveLength(1);

      failing.release();
      const failed = await (dialler === "fails" ? firstOutcome : secondOutcome);
      expect(failed.status).toBe("rejected");
      expect(servers).toHaveLength(1);
      expect(servers[0].closed).toBe(false);
      expect(clients[0].ended).toBe(false);

      opening.release();
      const opened = await (dialler === "fails" ? secondOutcome : firstOutcome);
      expect(opened.status).toBe("fulfilled");
      expect(clients).toHaveLength(1);
      expect(listenerOf((opened as { value: Opened }).value)?.closed).toBe(false);
    },
  );

  test("a connect that fails after a provider opened on the forward leaves the forward open", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const provider = await dialledAlone(opens);

    const failed = await settled(fails());

    expect(failed.status).toBe("rejected");
    expect(clients).toHaveLength(1);
    expect(listenerOf(provider)?.closed).toBe(false);
  });

  test("a forward every concurrent connect failed on is closed", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const first = settled(fails());
    await askedFor(1);
    const second = settled(fails());
    await askedFor(2);
    bastionAnswers();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(clients).toHaveLength(1);
    expect(servers).toHaveLength(1);
    expect(servers[0].closed).toBe(true);
    expect(clients[0].ended).toBe(true);
  });

  test("closing the connection closes the forward its provider opened on", async () => {
    connectionId = `tunnel-share-${sequence++}`;
    const provider = await dialledAlone(opens);

    await removeProvider(connectionId);

    expect(listenerOf(provider)?.closed).toBe(true);
    expect(clients[0].ended).toBe(true);
  });
});
