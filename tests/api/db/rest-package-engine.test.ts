/**
 * The cancel and disconnect routes on an engine an admitted provider package serves, through the real
 * `resolveServedConnection`, the provider factory's real caches, the real host core and the real cancel facade
 * (docs/providers/CONTRACT.md, clauses C-30, C-107, C-111 and C-112): a query's run on the package's editor session is
 * cancelled through the package's `console.cancel`, sent the run id the execute was sent with the session's handle
 * first; a session that does not offer the cancel answers the route's one refusal for every engine, calling nothing; a
 * package's open failure, its cancel's failure and a malformed cancel answer answer the one answer, logged once; and a
 * disconnect closes every cache entry the record's key names, and no other; under governance each user's cancel and
 * disconnect reach only that user's own session.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Paths are built with `path.join` by the fixture, no file mode, link or line ending is read, and nothing awaits a
 * timer: a cancel case waits on a promise the package's execute resolves when it starts, so every platform reaches the
 * same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext } from "@libredb/provider-sdk/calls";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { admittedConnection, grantedSnapshot } from "../../helpers/governance/granted-snapshot";

/** The session every request is read as: an admin, or a governed user a governance case sets. */
let caller: Record<string, unknown> = { role: "admin", username: "admin", iat: 1_700_000_000 };
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => caller),
  readSession: mock(async () => ({ kind: "authenticated", session: caller })),
}));

/** Each route under test, by its path under /api/db. */
const ROUTES: Readonly<Record<string, { POST: (req: never) => Promise<Response> }>> = {
  query: await import("@/app/api/db/query/route"),
  cancel: await import("@/app/api/db/cancel/route"),
  disconnect: await import("@/app/api/db/disconnect/route"),
  health: await import("@/app/api/db/health/route"),
};
const factory = await import("@/lib/db/factory");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");

/**
 * A package offering the cancel, granted no words; one offering it, granted its words; one offering no cancel; and one
 * offering the cancel whose register row lets a caller whose file access is denied open it, as a governed user's is.
 */
const REST = "acmerest";
const WORDS = "acmerestwords";
const PLAIN = "acmeplain";
const GOVERNED = "acmerestgoverned";
const providers = scratchDirectory("studio-package-engine-rest-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-rest", engine: REST, offered: ["console.cancel"] },
      { name: "acme-rest-words", engine: WORDS, offered: ["console.cancel"] },
      { name: "acme-plain", engine: PLAIN },
      { name: "acme-rest-governed", engine: GOVERNED, offered: ["console.cancel"] },
    ],
    { [WORDS]: { ownWords: "scrubbed" }, [GOVERNED]: { deniedFileAccessRefusal: null } },
  );
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

let spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

/** What one package's hooks saw, by call name, with each call's arguments. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

/** A result source answering one row. */
function source() {
  let done = false;
  return {
    columns: [{ name: "key" }],
    next: () => {
      const rows = done ? [] : [["alpha"]];
      done = true;
      return Promise.resolve({ rows, done: true });
    },
    close: () => Promise.resolve(),
  };
}

/** An execute answer of one row. */
const ROWS = () => ({ results: [source()], warnings: [], executionTimeMs: 1, pageApplied: false });

/** Hooks for `engine`'s package: open a fresh handle, close, read health, answer one row and cancel. */
function hooksFor(
  engine: string,
  options: {
    open?: () => Promise<unknown>;
    execute?: () => Promise<unknown>;
    cancel?: (request: unknown, handle: unknown) => Promise<unknown>;
  } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } }))),
    close: push("close", () => Promise.resolve()),
    health: push("health", () =>
      Promise.resolve({ databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] }),
    ),
    execute: push("execute", options.execute ?? (() => Promise.resolve(ROWS()))),
    cancel: push("cancel", (handle, request) =>
      (options.cancel ?? (() => Promise.resolve({ cancelled: false })))(request, handle),
    ),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The calls `seen` recorded of `name`. */
const callsNamed = (seen: Seen, name: string) => seen.calls.filter((call) => call.name === name);

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string, id = `conn-${randomUUID()}`): Record<string, unknown> {
  return { id, name: "Rest", type: engine, host: "rest.local", password: randomUUID() };
}

/** The status and body `route` answers for `body`. */
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const handler = ROUTES[route] as { POST: (req: never) => Promise<Response> };
  const response = await handler.POST(
    new Request(`http://localhost:3000/api/db/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<unknown>(response) };
}

/** The lines `logger.error` and `logger.warn` write while the case runs, each as its message and its error's words. */
function loggedLines(): () => [string, string][] {
  const lines: [string, string][] = [];
  const record = (message: unknown, payload?: unknown) => {
    lines.push([String(message), payload instanceof Error ? payload.message : JSON.stringify(payload ?? null)]);
  };
  spies.push(
    spyOn(logger, "error").mockImplementation(record),
    spyOn(logger, "warn").mockImplementation(record),
    spyOn(logger, "info").mockImplementation(() => undefined),
  );
  return () => lines.splice(0);
}

describe("the cancel route on a provider package's engine", () => {
  test("cancel runs on a package engine's session through the console's cancel", async () => {
    const connection = connectionOf(REST);
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const seen = hooksFor(REST, {
      execute: () => {
        started();
        return new Promise((resolve) => {
          release = () => resolve(ROWS());
        });
      },
      cancel: () => {
        release();
        return Promise.resolve({ cancelled: true });
      },
    });
    const queryId = randomUUID();
    const running = post("query", { connection, sql: "SELECT 1", queryId });
    await executing;

    expect(await post("cancel", { connection, queryId })).toEqual({ status: 200, body: { cancelled: true } });
    expect((await running).status).toBe(200);
    // One session: the cancel found the run on the editor's session the query opened, its handle first.
    expect(names(seen)).toEqual(["open", "execute", "cancel"]);
    const [execute] = callsNamed(seen, "execute");
    const [cancel] = callsNamed(seen, "cancel");
    expect(cancel?.args[0]).toBe(execute?.args[0]);
    expect(cancel?.args[1]).toEqual({ runId: queryId });
    expect((execute?.args[1] as { runId?: string }).runId).toBe(queryId);
    expect((cancel?.args[2] as CallContext).signal.aborted).toBe(false);

    // A run the package does not know answers not cancelled, on the same session.
    hooksFor(REST);
    expect(await post("cancel", { connection, queryId: randomUUID() })).toEqual({
      status: 200,
      body: { cancelled: false },
    });
  });

  test("a package engine whose session does not offer console.cancel answers the cancel route's one refusal, cancelled false, calling nothing", async () => {
    const seen = hooksFor(PLAIN);
    const answer = await post("cancel", { connection: connectionOf(PLAIN), queryId: randomUUID() });
    expect(answer).toEqual({
      status: 400,
      body: { error: "Query cancellation is not supported for this database type", cancelled: false },
    });
    expect(names(seen)).toEqual(["open"]);

    // The queryId is checked after the connection resolves, as for every engine, and before any open.
    const missing = await post("cancel", { connection: connectionOf(PLAIN) });
    expect(missing).toEqual({ status: 400, body: { error: "Connection and queryId are required" } });
    expect(names(seen)).toEqual(["open"]);
  });

  test("the cancel route answers a package's open failure as not-sent, its cancel failure by its grant, and a malformed cancel answer as the package's defect", async () => {
    const lines = loggedLines();
    for (const engine of [REST, WORDS]) {
      const granted = engine === WORDS;

      // The open fails, its words naming the connection's secret: not-sent, logged once.
      const refusedOpen = connectionOf(engine);
      const words = `the store is away for ${String(refusedOpen.password)}`;
      hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
      const opened = await post("cancel", { connection: refusedOpen, queryId: randomUUID() });
      expect(opened.status).toBe(503);
      expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
      const sentence = (opened.body as { error: string }).error;
      if (granted) expect(sentence).toBe(PROVIDER_TEXT_WITHHELD);
      else expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's open failed"]);

      // The cancel rejects: Studio's sentence naming its code, or the words as raised, logged once.
      const connection = connectionOf(engine);
      const own = `the cancel failed ${randomUUID()}`;
      hooksFor(engine, { cancel: () => Promise.reject(new Error(own)) });
      const failed = await post("cancel", { connection, queryId: randomUUID() });
      expect(failed.status).toBe(500);
      expect((failed.body as { error: string }).error).toBe(
        granted ? own : "The provider package's cancel failed (INTERNAL_ERROR); the server's log holds its words.",
      );
      expect(lines().map(([message]) => message)).toEqual(["A provider package's cancel failed"]);

      // A cancel answer outside its form is the package's defect, named by its rule, logged once.
      hooksFor(engine, { cancel: () => Promise.resolve({ cancelled: "yes" }) });
      const malformed = await post("cancel", { connection, queryId: randomUUID() });
      expect(malformed.status).toBe(500);
      const defect = (malformed.body as { error: string }).error;
      expect(defect.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      if (!granted) {
        expect(defect).toBe(
          `${PACKAGE_DEFECT_PREFIX} it broke the rule cancel-answer-unreadable; the server's log names where.`,
        );
      }
      const defectLines = lines();
      expect(defectLines.map(([message]) => message)).toEqual(["A provider package's cancel failed"]);
      expect(defectLines[0]?.[1].startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      expect(JSON.stringify([opened.body, failed.body, malformed.body, defectLines])).not.toContain(
        String(refusedOpen.password),
      );
    }

    // No case answers a package engine 501.
    for (const engine of [REST, WORDS, PLAIN]) {
      hooksFor(engine);
      const answer = await post("cancel", { connection: connectionOf(engine), queryId: randomUUID() });
      expect([engine, answer.status === 501]).toEqual([engine, false]);
    }
  });
});

describe("the disconnect route on a provider package's engine", () => {
  test("disconnect removes every cache entry of a package engine's record, and no other record's", async () => {
    const id = `conn-${randomUUID()}`;
    const connection = connectionOf(REST, id);
    // The same id with other credentials frames other entries.
    const other = connectionOf(REST, id);
    const seen = hooksFor(REST);
    // The query opens the editor's session and the health read the metadata session, of each record.
    for (const record of [connection, other]) {
      expect((await post("query", { connection: record, sql: "SELECT 1" })).status).toBe(200);
      expect((await post("health", { connection: record })).status).toBe(200);
    }
    expect(callsNamed(seen, "open")).toHaveLength(4);
    const handles = callsNamed(seen, "open").length;

    expect(await post("disconnect", { connection })).toEqual({ status: 200, body: { success: true } });
    // Both of the record's sessions closed, each once; the other record's sessions stay.
    expect(callsNamed(seen, "close")).toHaveLength(2);
    expect(await post("query", { connection: other, sql: "SELECT 1" })).toMatchObject({ status: 200 });
    expect(callsNamed(seen, "open")).toHaveLength(handles);
    // The record's next query opens a new session.
    expect(await post("query", { connection, sql: "SELECT 1" })).toMatchObject({ status: 200 });
    expect(callsNamed(seen, "open")).toHaveLength(handles + 1);

    // A seed id removes nothing: one session serves every user of a seed, and the idle sweep closes it.
    expect(await post("disconnect", { connectionId: `seed:${randomUUID()}` })).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(callsNamed(seen, "close")).toHaveLength(2);
  });
});

describe("the cancel and disconnect routes on a provider package's engine under governance", () => {
  const ISSUER = "https://idp.example.com/realms/libredb";
  const user = (name: string) => ({
    role: "user",
    username: `${name}@example.com`,
    idpSubject: `${name}-subject`,
    idpIssuer: ISSUER,
    iat: 1_700_000_000,
  });
  const ALICE = user("alice");
  const BOB = user("bob");
  /** One governed connection of the package's engine, the same write grant to both users. */
  const SHOP = admittedConnection("shop", {
    write: true,
    extra: { type: GOVERNED, environment: "development" } as never,
  });
  let savedSource: string | undefined;
  beforeAll(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot(
      grantedSnapshot(
        [SHOP],
        [ALICE, BOB].map((user) => ({ subject: user.idpSubject, connection: SHOP, level: "write" as const })),
      ),
    );
  });
  afterAll(async () => {
    await factory.clearProviderCache();
    resetGovernanceState();
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
    caller = { role: "admin", username: "admin", iat: 1_700_000_000 };
  });

  /** `route`'s answer to `body` sent as `user`. */
  const as = (user: Record<string, unknown>, route: string, body: Record<string, unknown>) => {
    caller = user;
    return post(route, { connectionId: "seed:shop", ...body });
  };

  test("under governance a second user's cancel opens that user's own session and cancels nothing of the first's, and a disconnect closes the caller's sessions only", async () => {
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let aliceHandle: unknown;
    const seen = hooksFor(GOVERNED, {
      execute: () => {
        started();
        return new Promise((resolve) => {
          release = () => resolve(ROWS());
        });
      },
      // The cancel stops the run only on the session that runs it.
      cancel: (_request, handle) => {
        if (handle !== aliceHandle) return Promise.resolve({ cancelled: false });
        release();
        return Promise.resolve({ cancelled: true });
      },
    });
    const queryId = randomUUID();
    const aliceRun = as(ALICE, "query", { sql: "SELECT 1", queryId });
    await executing;
    aliceHandle = callsNamed(seen, "execute")[0]?.args[0];

    // Bob naming Alice's run id opens his own session and stops nothing.
    expect(await as(BOB, "cancel", { queryId })).toEqual({ status: 200, body: { cancelled: false } });
    expect(callsNamed(seen, "open")).toHaveLength(2);
    expect(callsNamed(seen, "cancel").map(({ args }) => args[0] === aliceHandle)).toEqual([false]);

    // Bob's disconnect closes his session and nothing of Alice's, whose run goes on.
    expect(await as(BOB, "disconnect", {})).toEqual({ status: 200, body: { success: true } });
    expect(callsNamed(seen, "close").map(({ args }) => args[0] === aliceHandle)).toEqual([false]);

    // Alice's own cancel reaches her run on her session.
    expect(await as(ALICE, "cancel", { queryId })).toEqual({ status: 200, body: { cancelled: true } });
    expect((await aliceRun).status).toBe(200);
    expect(callsNamed(seen, "cancel").map(({ args }) => args[0] === aliceHandle)).toEqual([false, true]);
    expect(callsNamed(seen, "open")).toHaveLength(2);
  });
});
