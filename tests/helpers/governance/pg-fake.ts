/**
 * A fake of the `pg` Pool for the governance tests, which install it with `mock.module("pg", ...)`.
 *
 * Pools and clients are real EventEmitters, as `pg` hands back: an `error` event with no listener throws, so a test
 * that emits one proves a listener is there. Every statement goes to `fakePg.respond`, which a test replaces to answer
 * a statement with rows, an error or a promise that never settles. A client refuses a second release as `pg-pool`
 * does, so a test also proves that each client is released exactly once.
 *
 * `FakeListenerClient` is the `pg` Client the governance listener holds outside the pool. Its statements go to
 * `fakePg.listenerRespond` and its connects to `fakePg.listenerConnecting`.
 */
import { EventEmitter } from "node:events";
import {
  buildListenerProbeStatement,
  buildPingNotifyStatement,
  buildSnapshotStatements,
} from "@/lib/governance/contract";

/** What a statement answers: its rows, or a rejection. */
export type Answer = Promise<{ rows: readonly unknown[] }>;

export class FakeClient extends EventEmitter {
  /** Every statement this client was given, in order. */
  readonly statements: string[] = [];
  /** How many times `release` was called. */
  releases = 0;
  /** What the first release passed: undefined for a normal release, the error otherwise. */
  releasedWith: unknown;

  constructor(readonly pool: FakePool) {
    super();
  }

  query(sql: string): Answer {
    this.statements.push(sql);
    return fakePg.respond(sql, this);
  }

  release(error?: unknown): void {
    if (this.releases > 0) throw new Error("Release called on client which has already been released to the pool.");
    this.releases += 1;
    this.releasedWith = error;
  }
}

export class FakePool extends EventEmitter {
  /** Every pool made since the last reset, in order. */
  static made: FakePool[] = [];

  /** Every client this pool handed out, in order. */
  readonly clients: FakeClient[] = [];
  ended = false;

  constructor(readonly config: Readonly<Record<string, unknown>>) {
    super();
    FakePool.made.push(this);
  }

  async connect(): Promise<FakeClient> {
    await fakePg.connecting(this);
    const client = new FakeClient(this);
    this.clients.push(client);
    return client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

/** The rows each read of a snapshot answers, by the name `buildSnapshotStatements` gives it. */
export interface SnapshotRows {
  readonly contract: readonly unknown[];
  readonly connections: readonly unknown[];
  readonly grants: readonly unknown[];
  readonly settings: readonly unknown[];
  readonly revocations: readonly unknown[];
  readonly canary: readonly unknown[];
}

/** A row of `contract` for one published version. */
export const contractRow = (version: number) => ({
  version,
  status: "current",
  sunset_after: null,
  notify_channel: "libredb_bridge",
});

/** A statement the listener's client was given, with its parameters. */
export interface ListenerStatement {
  readonly sql: string;
  readonly values: readonly unknown[] | undefined;
}

/**
 * The dedicated `pg` Client of the governance listener.
 *
 * Like PostgreSQL, it delivers a notification only on a channel it issued `LISTEN` for. `drop()` is what `pg` does
 * when the server or the network ends the connection: an `error` event, then `end`. Destroying the socket through
 * `connection.stream.destroy()` drops it the same way, as destroying `pg`'s socket does.
 */
export class FakeListenerClient extends EventEmitter {
  /** Every client made since the last reset, in order. */
  static made: FakeListenerClient[] = [];

  /** Every statement this client was given, in order. */
  readonly statements: ListenerStatement[] = [];
  /** The channels this client listens on. */
  readonly channels = new Set<string>();
  /** How many times `end` was called. */
  ends = 0;
  /** How many times the socket was destroyed. */
  destroyed = 0;
  readonly connection = {
    stream: {
      destroy: (): void => {
        this.destroyed += 1;
        this.drop(new Error("Connection terminated unexpectedly"));
      },
    },
  };

  constructor(readonly config: Readonly<Record<string, unknown>>) {
    super();
    FakeListenerClient.made.push(this);
  }

  async connect(): Promise<this> {
    await fakePg.listenerConnecting(this);
    return this;
  }

  query(sql: string, values?: readonly unknown[]): Answer {
    this.statements.push({ sql, values });
    return fakePg.listenerRespond(sql, values, this);
  }

  async end(): Promise<void> {
    this.ends += 1;
    this.emit("end");
  }

  /** Delivers a notification on `channel`, as the server does to a session that listens on it. */
  notify(channel: string, payload: string): void {
    if (this.channels.has(channel)) this.emit("notification", { processId: 4242, channel, payload });
  }

  /** What `pg` does when the connection ends without `end()`: an `error` event, then `end`. */
  drop(error: Error): void {
    this.emit("error", error);
    this.emit("end");
  }
}

/**
 * How the listener's connection answers by default, as PostgreSQL does: `LISTEN` subscribes the session, and the
 * session's own `pg_notify` reaches it before the statement answers, because the server sends a notification ahead
 * of the ReadyForQuery that completes the statement. Any other statement is refused, so a test sees it.
 */
export function answerListener(
  sql: string,
  values: readonly unknown[] | undefined,
  client: FakeListenerClient,
): Answer {
  const listen = /^LISTEN (\w+)$/.exec(sql);
  if (listen !== null) {
    client.channels.add(listen[1]);
    return Promise.resolve({ rows: [] });
  }
  if (sql === buildPingNotifyStatement()) {
    const [channel, payload] = values as readonly [string, string];
    client.notify(channel, payload);
    return Promise.resolve({ rows: [{ pg_notify: "" }] });
  }
  if (sql === buildListenerProbeStatement()) return Promise.resolve({ rows: [{ "?column?": 1 }] });
  return Promise.reject(new Error(`The fake listener connection has no answer for: ${sql}`));
}

/** A governance source that publishes version 1 and nothing else. */
export const EMPTY_SOURCE: SnapshotRows = {
  contract: [contractRow(1)],
  connections: [],
  grants: [],
  settings: [],
  revocations: [],
  canary: [],
};

/**
 * Answers every statement of a snapshot of `schema` from `rows`, and `BEGIN` and `COMMIT` with no rows. A statement
 * that is not one of them is refused, so a test sees any statement the loader was not meant to issue.
 */
export function answerSnapshot(rows: SnapshotRows, schema = "bridge"): (sql: string) => Answer {
  const { begin, commit, ...reads } = buildSnapshotStatements(schema);
  const answers = new Map<string, readonly unknown[]>([
    [begin, []],
    [commit, []],
    ...Object.entries(reads).map(([name, sql]) => [sql, rows[name as keyof SnapshotRows]] as const),
  ]);
  return async (sql) => {
    const answer = answers.get(sql);
    if (answer === undefined) throw new Error(`The fake governance source has no answer for: ${sql}`);
    return { rows: answer };
  };
}

/** An error the server sent, as `pg` raises it: its message, its SQLSTATE and the server's severity. */
export const pgError = (code: string, message: string, severity = "ERROR"): Error =>
  Object.assign(new Error(message), { code, severity });

/** A socket error, as Node raises it under `pg`: a Node error code and no severity. */
export const nodeError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface FakePgControl {
  /** Answers one statement. */
  respond: (sql: string, client: FakeClient) => Answer;
  /** Runs before a client is handed out: reject to refuse the connection, or hold to keep it pending. */
  connecting: (pool: FakePool) => Promise<void>;
  /** Answers one statement of the listener's connection. */
  listenerRespond: (sql: string, values: readonly unknown[] | undefined, client: FakeListenerClient) => Answer;
  /** Runs when the listener's client connects: reject to refuse the connection, or hold to keep it pending. */
  listenerConnecting: (client: FakeListenerClient) => Promise<void>;
  /**
   * Back to a governance source that answers `EMPTY_SOURCE` and the listener's statements and accepts every
   * connection, with no pool and no listener client made.
   */
  reset: () => void;
}

export const fakePg: FakePgControl = {
  respond: answerSnapshot(EMPTY_SOURCE),
  connecting: async () => {},
  listenerRespond: answerListener,
  listenerConnecting: async () => {},
  reset() {
    fakePg.respond = answerSnapshot(EMPTY_SOURCE);
    fakePg.connecting = async () => {};
    fakePg.listenerRespond = answerListener;
    fakePg.listenerConnecting = async () => {};
    FakePool.made = [];
    FakeListenerClient.made = [];
  },
};

/** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
