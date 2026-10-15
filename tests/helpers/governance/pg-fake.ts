/**
 * A fake of the `pg` Pool for the governance tests, which install it with `mock.module("pg", ...)`.
 *
 * Pools and clients are real EventEmitters, as `pg` hands back: an `error` event with no listener throws, so a test
 * that emits one proves a listener is there. Every statement goes to `fakePg.respond`, which a test replaces to answer
 * a statement with rows, an error or a promise that never settles. A client refuses a second release as `pg-pool`
 * does, so a test also proves that each client is released exactly once.
 */
import { EventEmitter } from "node:events";
import { buildSnapshotStatements } from "@/lib/governance/contract";

/** What a statement answers: its rows, or a rejection. */
type Answer = Promise<{ rows: readonly unknown[] }>;

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
  /** Back to a governance source that answers `EMPTY_SOURCE` and accepts every connection, with no pool made. */
  reset: () => void;
}

export const fakePg: FakePgControl = {
  respond: answerSnapshot(EMPTY_SOURCE),
  connecting: async () => {},
  reset() {
    fakePg.respond = answerSnapshot(EMPTY_SOURCE);
    fakePg.connecting = async () => {};
    FakePool.made = [];
  },
};

/** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
