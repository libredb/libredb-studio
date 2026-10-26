/**
 * Threat: one signed-in user of a governed connection reaching another user's database session through Studio's
 * shared server process (docs/SECURITY.md, control 0.9).
 *
 * Without governance every user of a connection shares one provider: one pool, one database session state and one
 * interactive transaction, and a disconnect removes only what the caller's own record names
 * (docs/SECURITY.md, note 0.9). Under governance each user's requests run on a provider of their own, keyed by the
 * session's identity provider subject, so two users granted the same level on the same connection, which resolve to
 * the same record and the same credential, still never share a provider, a transaction, a cancel or a disconnect. This
 * file proves it through the routes themselves: the governed `resolveConnection`, the real factory and the real
 * PostgreSQL provider, over a fake `pg` that records which pool and which session each statement reached.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as auth from "@/lib/auth";
import { admittedConnection, grantedSnapshot } from "../helpers/governance/granted-snapshot";

/** The text of the statement that runs until a cancel stops it. */
const SLOW_STATEMENT = "SELECT pg_sleep(60)";

/** How PostgreSQL ends a statement that `pg_cancel_backend` cancelled. */
const cancelledByUser = (): Error =>
  Object.assign(new Error("canceling statement due to user request"), { code: "57014" });

/** Every session any fake pool opened, so `pg_cancel_backend` can find the one its pid names, as the server does. */
const sessions: FakeSession[] = [];

/** One database session: its backend pid, the transaction status the server reports, and the statement it runs. */
class FakeSession {
  readonly pid = 1000 + sessions.length;
  /** The ReadyForQuery status after the last statement, which `pg` publishes as `getTransactionStatus()`. */
  status: "I" | "T" = "I";
  /** Ends the statement this session runs until a cancel stops it, while there is one. */
  stopRunning: ((error: Error) => void) | null = null;

  constructor(readonly pool: FakePool) {
    sessions.push(this);
  }

  getTransactionStatus(): "I" | "T" {
    return this.status;
  }

  async query(config: string | { text: string; rowMode?: string }, values?: unknown[]) {
    const text = typeof config === "string" ? config : config.text;
    this.pool.statements.push(text);
    if (text === "SELECT pg_backend_pid() as pid") return { rows: [{ pid: this.pid }], fields: [], rowCount: 1 };
    if (text.startsWith("SELECT pg_cancel_backend(")) {
      const stop = sessions.find((session) => session.pid === values?.[0])?.stopRunning;
      if (typeof stop === "function") stop(cancelledByUser());
      return { rows: [{ cancelled: typeof stop === "function" }], fields: [], rowCount: 1 };
    }
    if (text === "BEGIN") this.status = "T";
    if (text === "COMMIT" || text === "ROLLBACK") this.status = "I";
    // The limiter may append its bound, so the slow statement is told by what it calls.
    if (text.includes("pg_sleep")) {
      return new Promise<never>((_resolve, reject) => {
        this.stopRunning = (error) => {
          this.stopRunning = null;
          reject(error);
        };
      });
    }
    // A user's statement asks for array rows; every other statement is a probe the provider reads nothing from here.
    if (typeof config === "object" && config.rowMode === "array") {
      return { rows: [[1]], fields: [{ name: "answer", dataTypeID: 23 }], rowCount: 1 };
    }
    return { rows: [], fields: [], rowCount: 0 };
  }

  release(): void {}
}

/** A `pg` Pool: every session it opened and every statement they ran, in order, and whether it was ended. */
class FakePool extends EventEmitter {
  /** Every pool a provider opened, oldest first. */
  static made: FakePool[] = [];

  readonly sessions: FakeSession[] = [];
  readonly statements: string[] = [];
  ended = false;

  constructor(readonly config: { min?: number; max?: number }) {
    super();
    FakePool.made.push(this);
  }

  async connect(): Promise<FakeSession> {
    if (this.ended) throw new Error("Cannot use a pool after calling end on the pool");
    const session = new FakeSession(this);
    this.sessions.push(session);
    return session;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const realPg = await import("pg");
const fakePg = { Pool: FakePool, Client: realPg.Client, types: realPg.types };
mock.module("pg", () => ({ ...fakePg, default: fakePg }));

/** A route's POST handler, called with a plain Request as the server calls it. */
type Handler = (request: Request) => Promise<Response>;
const handler = (module: { POST: unknown }): Handler => module.POST as Handler;

const queryRoute = handler(await import("@/app/api/db/query/route"));
const transactionRoute = handler(await import("@/app/api/db/transaction/route"));
const cancelRoute = handler(await import("@/app/api/db/cancel/route"));
const disconnectRoute = handler(await import("@/app/api/db/disconnect/route"));
const { clearProviderCache, getProviderCacheStats } = await import("@/lib/db/factory");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");

const ISSUER = "https://idp.example.com/realms/libredb";
const ALICE: auth.UserPayload = {
  role: "user",
  username: "alice@example.com",
  idpSubject: "alice-subject",
  idpIssuer: ISSUER,
};
const BOB: auth.UserPayload = {
  role: "user",
  username: "bob@example.com",
  idpSubject: "bob-subject",
  idpIssuer: ISSUER,
};

/** One connection, and the same write grant to both users: their records and credentials are the same. */
const ORDERS = admittedConnection("orders", { write: true });
const GRANTS = [
  { subject: ALICE.idpSubject as string, connection: ORDERS, level: "write" as const },
  { subject: BOB.idpSubject as string, connection: ORDERS, level: "write" as const },
];

let savedSource: string | undefined;

beforeAll(() => {
  savedSource = process.env.GOVERNANCE_SOURCE;
  process.env.GOVERNANCE_SOURCE = "postgres";
});

afterAll(async () => {
  await clearProviderCache();
  resetGovernanceState();
  if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedSource;
});

/** The session reader, answering as whoever `send` last sent a request for. */
let getSession: ReturnType<typeof spyOn>;
let readSession: ReturnType<typeof spyOn>;
/** The console the factory announces every provider it builds on. */
let consoleLog: ReturnType<typeof spyOn>;
const quiet: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  clearRateLimitState();
  recordGovernanceSnapshot(grantedSnapshot([ORDERS], GRANTS));
  getSession = spyOn(auth, "getSession").mockResolvedValue(ALICE);
  readSession = spyOn(auth, "readSession").mockImplementation(async () => {
    const s = await auth.getSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  });
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
  quiet.push(...[spyOn(logger, "info"), spyOn(logger, "debug")].map((spy) => spy.mockImplementation(() => {})));
});

afterEach(() => {
  getSession.mockRestore();
  readSession.mockRestore();
  consoleLog.mockRestore();
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

/** Sends `body` to `route` as `session`, as that user's browser would, and reads the answer. */
async function send(session: auth.UserPayload, route: Handler, body: Record<string, unknown>) {
  getSession.mockResolvedValue(session);
  const response = await route(
    new Request("http://localhost/api/db/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const onOrders = (body: Record<string, unknown>) => ({ connectionId: "seed:orders", ...body });

/** How many providers the factory announced since the test began. */
const providersBuilt = (): number =>
  consoleLog.mock.calls.filter((call: unknown[]) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating "))
    .length;

/** Waits, at most two seconds, until the fake server reports what `reached` asks for. */
async function until(reached: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error("the fake server never reached the awaited state");
    // oxlint-disable-next-line no-await-in-loop -- a poll: each wait must end before the server is looked at again.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("per-user isolation under governance", () => {
  test("under governance two users of one connection never share a provider, a transaction, a cancel or a disconnect", async () => {
    // A PROVIDER: each user's first statement opens a provider and a pool of their own, with the owner's pool size,
    // and a user's next statement is served by the provider they already hold.
    expect((await send(ALICE, queryRoute, onOrders({ sql: "SELECT 1" }))).status).toBe(200);
    expect((await send(BOB, queryRoute, onOrders({ sql: "SELECT 1" }))).status).toBe(200);
    expect((await send(ALICE, queryRoute, onOrders({ sql: "SELECT 1" }))).status).toBe(200);

    expect(providersBuilt()).toBe(2);
    expect(getProviderCacheStats()).toEqual({ size: 2, connections: ["seed:orders", "seed:orders"] });
    const [alicePool, bobPool] = FakePool.made;
    expect(FakePool.made.map(({ config }) => ({ min: config.min, max: config.max }))).toEqual([
      { min: 0, max: 3 },
      { min: 0, max: 3 },
    ]);

    // A TRANSACTION: Alice's open transaction is neither seen nor joined by Bob, who begins one of his own.
    expect(await send(ALICE, transactionRoute, onOrders({ action: "begin" }))).toMatchObject({ status: 200 });
    const aliceTransaction = alicePool.sessions.find((session) => session.status === "T");
    expect(aliceTransaction).toBeDefined();
    expect(await send(BOB, transactionRoute, onOrders({ action: "status" }))).toEqual({
      status: 200,
      body: { inTransaction: false, ownedByYou: false, heldByAnotherSession: false, startedAt: null },
    });
    expect((await send(BOB, queryRoute, onOrders({ sql: "SELECT 2" }))).status).toBe(200);
    expect(await send(BOB, transactionRoute, onOrders({ action: "begin" }))).toMatchObject({ status: 200 });
    expect(bobPool.sessions.filter((session) => session.status === "T")).toHaveLength(1);
    // Nothing Bob sent reached a session of Alice's pool.
    expect(alicePool.statements.some((statement) => statement.includes("SELECT 2"))).toBe(false);

    // A CANCEL: Alice's statement runs under the id her editor minted, and Bob naming that id stops nothing.
    const aliceRun = send(ALICE, queryRoute, onOrders({ sql: SLOW_STATEMENT, queryId: "alice-query" }));
    await until(() => alicePool.sessions.some((session) => session.stopRunning !== null));
    const aliceRunning = alicePool.sessions.find((session) => session.stopRunning !== null);
    expect(aliceRunning).toBeDefined();

    expect(await send(BOB, cancelRoute, onOrders({ queryId: "alice-query" }))).toEqual({
      status: 200,
      body: { cancelled: false },
    });
    expect(aliceRunning?.stopRunning).not.toBeNull();
    const cancels = (pool: FakePool) => pool.statements.filter((statement) => statement.includes("pg_cancel_backend"));
    expect([cancels(alicePool), cancels(bobPool)]).toEqual([[], []]);

    // A DISCONNECT: Bob ends his transaction and disconnects, which closes his provider and nothing of Alice's.
    expect(await send(BOB, transactionRoute, onOrders({ action: "rollback" }))).toMatchObject({ status: 200 });
    expect(await send(BOB, disconnectRoute, { connectionId: "seed:orders" })).toEqual({
      status: 200,
      body: { success: true },
    });
    expect([alicePool.ended, bobPool.ended]).toEqual([false, true]);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: ["seed:orders"] });
    expect(aliceRunning?.stopRunning).not.toBeNull();
    expect(aliceTransaction?.status).toBe("T");
    expect(await send(ALICE, transactionRoute, onOrders({ action: "status" }))).toMatchObject({
      status: 200,
      body: { inTransaction: true, ownedByYou: true, heldByAnotherSession: false },
    });

    // The control: Alice's own cancel reaches her statement, and her transaction commits on the provider she kept.
    expect(await send(ALICE, cancelRoute, onOrders({ queryId: "alice-query" }))).toEqual({
      status: 200,
      body: { cancelled: true },
    });
    expect(await aliceRun).toMatchObject({ status: 499, body: { code: "QUERY_CANCELLED" } });
    expect(cancels(alicePool)).toHaveLength(1);
    expect(await send(ALICE, transactionRoute, onOrders({ action: "commit" }))).toMatchObject({ status: 200 });
    expect(aliceTransaction?.status).toBe("I");
    expect(providersBuilt()).toBe(2);
  });
});
