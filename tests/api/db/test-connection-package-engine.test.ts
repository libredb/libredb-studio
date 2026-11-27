/**
 * `POST /api/db/test-connection` for an engine a provider package serves (docs/providers/CONTRACT.md, clauses C-107 and
 * C-112), through the real `resolveServedConnection`, the factory's real one-shot open (`openEngineOnce`) and tunnel
 * scope, each wrapped to record its calls, and the real host core: an admitted engine's connection is validated
 * against its declaration's field rules and the open checks, each refusal a not-sent configuration error, then one
 * session opens through the package, its health is read and it is closed; a package's own words reach the client only
 * where its register row grants them, and then through core's scrub, and a failure is logged by its author, the package's as the package's and Studio's as Studio's; a refused package's
 * engine answers `PROVIDER_UNAVAILABLE` naming the code. A legacy engine's connection runs the same test, told apart
 * only by its record's offers. The factory's other entry points are stood in for and never reached.
 *
 * The packages are in-memory records whose functions call the hooks a case sets, composed against a register of their
 * own (tests/helpers/package-catalog.ts `packageRow`) that grants two of them a row. The deadline case runs on an engine
 * record whose budget is 50 ms; it settles on the route's own answer, never on a timer the test awaits.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseGrantRegister } from "@libredb/grant-register";
import { type CallRefusal, callRefusalSentence, type ProviderImpl } from "@libredb/provider-sdk/calls";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { type EngineRecord, forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { HostDefectError, refusalError } from "@/lib/provider-host/access";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import {
  admittedFor,
  admittedManifest,
  type EditableEngine,
  packageRow,
  withFieldRules,
} from "../../helpers/package-catalog";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// The spread form, not a hand-written stub: only the session readers are replaced (backlog D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

/** The factory's real one-shot open and one-shot tunnel scope, taken before the factory is stood in for. */
const { openEngineOnce, withOneShotTunnel } = await import("@/lib/db/factory");

/** Every call into the factory's legacy entry points, by name: none may happen for a package engine. */
const factoryCalls: string[] = [];
const recorded = (name: string) => async (): Promise<never> => {
  factoryCalls.push(name);
  throw new Error(`the factory's ${name} was reached`);
};
/** The type of each connection the one-shot tunnel scope was entered for. */
const tunnelled: string[] = [];
/** The id of each engine record the one-shot open opened. */
const opens: string[] = [];
/** A case's stand-in for the one-shot open, which every case leaves the real one. */
let openOverride: typeof openEngineOnce | undefined;
mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: (...args: Parameters<typeof withOneShotTunnel>) => {
    tunnelled.push(args[0].type);
    return withOneShotTunnel(...args);
  },
  createDatabaseProvider: recorded("createDatabaseProvider"),
  findOpenSingleWriterProvider: () => {
    factoryCalls.push("findOpenSingleWriterProvider");
    return null;
  },
  isSingleWriterFileOpen: () => {
    factoryCalls.push("isSingleWriterFileOpen");
    return false;
  },
  getOrCreateProvider: recorded("getOrCreateProvider"),
  removeProvider: recorded("removeProvider"),
  clearProviderCache: recorded("clearProviderCache"),
  getProviderCacheStats: () => ({ size: 0, connections: [] }),
  openEngineOnce: (...args: Parameters<typeof openEngineOnce>) => {
    opens.push(args[1].id);
    return (openOverride ?? openEngineOnce)(...args);
  },
}));

const { POST } = await import("@/app/api/db/test-connection/route");

/** The hooks the packages' functions call, set per case. */
let hooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
/** The names of the package calls a case saw, in order. */
const seen: string[] = [];

/** An implementation whose every function records its name and calls the case's hook. */
function hookImpl(): ProviderImpl<unknown> {
  const call =
    (name: string) =>
    (...args: unknown[]) => {
      seen.push(name);
      return (hooks[name] ?? (() => Promise.resolve(undefined)))(...args);
    };
  return {
    open: call("open"),
    close: call("close"),
    health: call("health"),
    console: { execute: call("execute") },
    monitoring: { panel: call("panel") },
  } as unknown as ProviderImpl<unknown>;
}

const HEALTH = { databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] };

/** `pkg` with its record's implementation replaced by one that calls the case's hooks. */
function withHookImpl(pkg: AdmittedForCatalog): AdmittedForCatalog {
  return { ...pkg, record: { ...pkg.record, impl: hookImpl() } };
}

/** A request of write reach none, which states every write path absent. */
function readOnlyClaims(engine: EditableEngine): void {
  engine.policy = { ...engine.policy, writeReach: "none" };
  const absent = { reach: "absent", proof: { module: "src/read-only.ts", symbol: "readOnly" } };
  engine.safeguards = {
    ...engine.safeguards,
    writePaths: { editor: absent, objectEdit: absent, maintenance: absent, transaction: absent },
  };
}

/** Hooks of a package that opens, answers its health and closes. */
function healthyHooks(): typeof hooks {
  return {
    open: () => Promise.resolve({ handle: { session: randomUUID() } }),
    health: () => Promise.resolve(HEALTH),
    close: () => Promise.resolve(),
  };
}

beforeAll(() => {
  installHostCore(createHostCore(), "test");
  const tested = admittedFor("acme-tested", admittedManifest("acmetested", withFieldRules));
  const brief = admittedFor("acme-brief", admittedManifest("acmetestbrief"));
  const words = admittedFor("acme-words", admittedManifest("acmetestwords"));
  const reach = admittedFor("acme-reach", admittedManifest("acmetestreach", readOnlyClaims));
  const unreached = admittedFor("acme-unreached", admittedManifest("acmetestunreached", readOnlyClaims));
  const register = parseGrantRegister(
    [
      packageRow(words, "acmetestwords", { ownWords: "scrubbed" }),
      packageRow(reach, "acmetestreach", { writeReach: "none" }),
    ],
    LEGACY_ENGINE_IDS,
  );
  const composed = composeServerCatalog(
    [tested, brief, words, reach, unreached].map(withHookImpl),
    [{ name: "acme-gone", version: "1.0.0", engines: ["acmetestgone"], code: "PROVIDER_LOAD_FAILED" }],
    register,
  );
  const briefEngine = composed.engines.get("acmetestbrief") as EngineRecord;
  installServerCatalog({
    engines: new Map([
      ...composed.engines,
      ["acmetestbrief", { ...briefEngine, catalog: { ...briefEngine.catalog, connectBudgetMs: 50 } }],
    ]),
    unavailable: composed.unavailable,
  });
});
afterAll(forgetServerCatalog);

beforeEach(() => {
  factoryCalls.length = 0;
  tunnelled.length = 0;
  opens.length = 0;
  openOverride = undefined;
  seen.length = 0;
  hooks = healthyHooks();
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
});

/** The route's status and body for `connection`, posted as the dialog posts it. */
async function routeAnswer(
  connection: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  clearRateLimitState();
  const request = createMockRequest("/api/db/test-connection", {
    method: "POST",
    body: { connection: { id: "user-conn", name: "Mine", ...connection } },
  });
  const response = await POST(request as never);
  return { status: response.status, body: (await parseResponseJSON(response)) as Record<string, unknown> };
}

const VALID = { type: "acmetested", host: "db.local", user: "writer" };

/** The error the accessor builds for a call the host refused with `refusal`, after the package was called. */
function hostDefect(refusal: CallRefusal): HostDefectError {
  const error = refusalError(
    { kind: "refused", called: true, refusals: [refusal] },
    { caller: new AbortController().signal, deadlineSentence: "The open ran past its budget." },
  );
  if (!(error instanceof HostDefectError)) throw new Error(`expected a host defect, got ${error.name}`);
  return error;
}

describe("POST /api/db/test-connection for a provider package's engine", () => {
  test("Test Connection opens an admitted engine's session through its package, reads its health and closes it", async () => {
    const type = "acmetested";
    const refusals: [Record<string, unknown>, string][] = [
      [{ database: "d" }, "Enter the host. Nothing was sent."],
      [{ host: "Bad Host", database: "d" }, "Host is letters, digits, dots and hyphens."],
      [{ host: "db.local", user: "ab" }, "User is 3 to 16 characters."],
      [{ host: "db.local" }, "Enter the database. Nothing was sent."],
      [
        { host: "db.local", user: "writer", password: randomUUID() },
        "This LibreDB Studio cannot run the check the provider package declares for the field password, so it does not send this connection.",
      ],
    ];
    for (const [fields, sentence] of refusals) {
      const { status, body } = await routeAnswer({ type, ...fields });
      expect([status, body.code, body.error, body.outcome]).toEqual([400, "CONFIG_ERROR", sentence, "not-sent"]);
    }
    expect(seen).toEqual([]);

    // A hidden database is not checked, and an empty password passes the named check.
    for (const fields of [
      { host: "db.local", user: "writer" },
      { host: "db.local", user: "reader", database: "d", password: "" },
    ]) {
      seen.length = 0;
      const { status, body } = await routeAnswer({ type, ...fields });
      expect(status).toBe(200);
      expect([body.success, body.message, typeof body.latency]).toEqual([true, "Connection successful", "number"]);
      expect(seen).toEqual(["open", "health", "close"]);
    }
    expect(factoryCalls).toEqual([]);
  });

  test("a health failure answers the degraded success with Studio's sentence naming its code, and the session is still closed", async () => {
    const secret = randomUUID();
    hooks.health = () => Promise.reject(new Error(secret));
    const error = spyOn(logger, "error");
    try {
      const { status, body } = await routeAnswer(VALID);
      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        degraded: true,
        message:
          "Connected, but this server answered no health data: The provider package's health failed (INTERNAL_ERROR); the server's log holds its words.",
      });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(seen).toEqual(["open", "health", "close"]);
      expect(error.mock.calls.filter(([line]) => line === "A provider package's health failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("an open past the engine's connect budget answers ConnectionError naming the budget, and the late session is closed once it settles", async () => {
    let answer!: (value: unknown) => void;
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => {
      closed = resolve;
    });
    hooks.open = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    hooks.close = (handle) => {
      closed();
      expect(handle).toEqual({ late: true });
      return Promise.resolve();
    };
    const { status, body } = await routeAnswer({ type: "acmetestbrief", host: "db.local" });
    expect([status, body.code]).toEqual([503, "CONNECTION_ERROR"]);
    expect(body.error).toStartWith("The connection test got no answer within");
    answer({ handle: { late: true } });
    await closing;
    expect(seen).toEqual(["open", "close"]);
  });

  test("an open that fails answers Studio's sentence naming its code, not-sent, and a close that fails does not change the answer", async () => {
    const secret = randomUUID();
    hooks.open = () => Promise.reject(new Error(secret));
    const error = spyOn(logger, "error");
    const warn = spyOn(logger, "warn");
    try {
      const failed = await routeAnswer(VALID);
      expect([failed.status, failed.body.code, failed.body.outcome]).toEqual([503, "CONNECTION_ERROR", "not-sent"]);
      expect(failed.body.error).toBe(
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      );
      expect(JSON.stringify(failed.body)).not.toContain(secret);

      hooks = { ...healthyHooks(), close: () => Promise.reject(new Error(secret)) };
      const answered = await routeAnswer(VALID);
      expect([answered.status, answered.body.message]).toEqual([200, "Connection successful"]);
      const line = warn.mock.calls.find(
        ([text]) => text === "Test Connection's session of a provider package did not close",
      );
      expect(line?.[1]).toMatchObject({ close: "failed", kind: "internal", code: "INTERNAL_ERROR" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  test("a granted package's open failure answers a not-sent connection error with its scrubbed words, as a code-only one answers Studio's sentence", async () => {
    const secret = randomUUID();
    const words = `the server refused this client ${randomUUID()}`;
    const granted = { type: "acmetestwords", host: "db.local", password: secret };
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The open's own words, through core's scrub, as a connection error: an open sends no statement.
      hooks.open = () => Promise.reject(new Error(words));
      const open = await routeAnswer(granted);
      expect([open.status, open.body.code, open.body.outcome, open.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        words,
      ]);
      // The health failure's own words, in the degraded success's sentence.
      hooks = { ...healthyHooks(), health: () => Promise.reject(new Error(words)) };
      const health = await routeAnswer(granted);
      expect([health.status, health.body.degraded, health.body.message]).toEqual([
        200,
        true,
        `Connected, but this server answered no health data: ${words}`,
      ]);
      // Words holding the connection's password are withheld whole, in each answer.
      hooks.open = () => Promise.reject(new Error(`${words} for ${secret}`));
      const withheldOpen = await routeAnswer(granted);
      hooks = { ...healthyHooks(), health: () => Promise.reject(new Error(`${words} for ${secret}`)) };
      const withheldHealth = await routeAnswer(granted);
      expect([withheldOpen.status, withheldOpen.body.outcome, withheldHealth.status]).toEqual([503, "not-sent", 200]);
      for (const answer of [withheldOpen.body, withheldHealth.body]) {
        expect(JSON.stringify(answer)).not.toContain(secret);
        expect(JSON.stringify(answer)).not.toContain(words);
      }

      // No row: Studio's sentence naming the code.
      hooks = { ...healthyHooks(), open: () => Promise.reject(new Error(words)) };
      const coded = await routeAnswer(VALID);
      expect([coded.status, coded.body.code, coded.body.outcome, coded.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
    } finally {
      error.mockRestore();
    }
  });

  test("a package's open failure is logged once on both grants: the route's answer writes no second line", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      for (const type of ["acmetestwords", "acmetested"]) {
        error.mockClear();
        warn.mockClear();
        hooks = { ...healthyHooks(), open: () => Promise.reject(new Error(randomUUID())) };
        const failed = await routeAnswer({ ...VALID, type });
        expect([type, failed.status, failed.body.code]).toEqual([type, 503, "CONNECTION_ERROR"]);
        expect([type, ...error.mock.calls.map(([line]) => line)]).toEqual([type, "A provider package's open failed"]);
        expect(warn.mock.calls).toEqual([]);
      }
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  test("a package engine whose register row grants its write reach opens a read-only connection, and one without a row is refused before the open", async () => {
    const granted = await routeAnswer({ type: "acmetestreach", host: "db.local", readOnly: true });
    expect([granted.status, granted.body.success, granted.body.message]).toEqual([200, true, "Connection successful"]);
    expect(seen).toEqual(["open", "health", "close"]);

    seen.length = 0;
    const refused = await routeAnswer({ type: "acmetestunreached", host: "db.local", readOnly: true });
    expect([refused.status, refused.body.code, refused.body.outcome]).toEqual([400, "CONFIG_ERROR", "not-sent"]);
    expect(refused.body.error).toStartWith("readOnly: true is refused for acmetestunreached");
    expect(seen).toEqual([]);
  });

  test("the open checks refuse before the budget starts", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { readOnly: true },
        "readOnly: true is refused for acmetested: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.",
      ],
      [
        { sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password" } },
        "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.",
      ],
    ];
    for (const [fields, sentence] of cases) {
      const { status, body } = await routeAnswer({ ...VALID, ...fields });
      expect([status, body.code, body.error, body.outcome]).toEqual([400, "CONFIG_ERROR", sentence, "not-sent"]);
    }
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "user" }));
    const { status, body } = await routeAnswer(VALID);
    expect([status, body.code]).toEqual([400, "CONFIG_ERROR"]);
    expect(body.error).toStartWith("Connections of this engine require an administrator");
    expect(seen).toEqual([]);
  });

  test("Test Connection answers PROVIDER_UNAVAILABLE naming the refusal code for a refused package's engine", async () => {
    const { status, body } = await routeAnswer({ type: "acmetestgone", host: "db.local" });
    expect([status, body.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    expect(body.error).toBe(
      'The connection type "acmetestgone" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_LOAD_FAILED), so no provider can open it; the server\'s log names the package and why.',
    );
    expect(factoryCalls).toEqual([]);
  });

  test("Test Connection runs one test for a legacy and a package engine, told apart only by the record's offers", async () => {
    for (const connection of [{ type: "sqlite", database: ":memory:" }, VALID]) {
      const { status, body } = await routeAnswer(connection);
      expect(status).toBe(200);
      expect([body.success, body.message, typeof body.latency]).toEqual([true, "Connection successful", "number"]);
    }
    // The legacy record offers a tunnel, so its test entered the one-shot tunnel scope; the package's record offers none.
    expect(tunnelled).toEqual(["sqlite"]);
    expect(opens).toEqual(["sqlite", "acmetested"]);
    expect(factoryCalls).toEqual([]);
    expect(seen).toEqual(["open", "health", "close"]);
  });

  test("a host defect during a package engine's test is logged as Studio's, and the package's own error as the package's", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    /** How many times each of the two attribution lines was logged since the last clear. */
    const attributed = () => {
      const lines = error.mock.calls.map(([line]) => String(line));
      return {
        studio: lines.filter((line) => line === "Unhandled error").length,
        open: lines.filter((line) => line === "A provider package's open failed").length,
        health: lines.filter((line) => line === "A provider package's health failed").length,
      };
    };
    const monitoring = await import("@/lib/api/provider-monitoring");
    const health = spyOn(monitoring, "readSessionHealthWithin");
    try {
      // A scope sent to a session that offers none is a request only Studio builds: Studio's defect.
      const studio = hostDefect({ rule: "request-scope-not-offered", pointer: "/scope" });
      openOverride = () => Promise.reject(studio);
      const own = await routeAnswer(VALID);
      expect([own.status, own.body.code, own.body.error]).toEqual([500, "INTERNAL_ERROR", studio.message]);
      expect(attributed()).toEqual({ studio: 1, open: 0, health: 0 });

      // The same defect raised while the session's health is read is Studio's too, and the session is still closed.
      error.mockClear();
      openOverride = undefined;
      health.mockImplementationOnce(() => Promise.reject(studio));
      const read = await routeAnswer(VALID);
      expect([read.status, read.body.code, read.body.error]).toEqual([500, "INTERNAL_ERROR", studio.message]);
      expect(attributed()).toEqual({ studio: 1, open: 0, health: 0 });
      expect(seen).toEqual(["open", "close"]);

      // A refinement that widens what the package declared is what the package answered: the package's defect, logged
      // in Studio's words naming the rule and the pointer, and answered to this engine, which no row grants its own
      // words, naming the rule alone; since an open sends no statement, as a connection error marked not-sent.
      error.mockClear();
      openOverride = () => Promise.reject(hostDefect({ rule: "refinement-widens", pointer: "/console" }));
      const widened = await routeAnswer(VALID);
      const defect = `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence({ rule: "refinement-widens", pointer: "/console" })}`;
      expect([widened.status, widened.body.code, widened.body.outcome, widened.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        `${PACKAGE_DEFECT_PREFIX} it broke the rule refinement-widens; the server's log names where.`,
      ]);
      expect(attributed()).toEqual({ studio: 0, open: 1, health: 0 });
      const logged = error.mock.calls.find(([line]) => line === "A provider package's open failed")?.[1];
      expect(String((logged as Error).message)).toBe(defect);

      // A value the package's own open rejects with is the package's.
      error.mockClear();
      openOverride = undefined;
      hooks.open = () => Promise.reject(new Error(randomUUID()));
      const rejected = await routeAnswer(VALID);
      expect([rejected.status, rejected.body.code]).toEqual([503, "CONNECTION_ERROR"]);
      expect(attributed()).toEqual({ studio: 0, open: 1, health: 0 });
    } finally {
      health.mockRestore();
      error.mockRestore();
    }
  });
});
