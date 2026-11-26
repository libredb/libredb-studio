import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CallContext } from "@libredb/provider-sdk/calls";
import { connectBudgetFor } from "@/lib/db/connect-budget";
import { ConnectionError, DatabaseConfigError, ProviderTextWithheldError, TimeoutError } from "@/lib/db/errors";
import { snowflakeAccountRefusal } from "@/lib/db/providers/sql/snowflake/account-host";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, EditorExecutionContext } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { serverOnlyReach, valueImportClosure } from "../../../helpers/value-import-closure";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { HealthSession } from "@/lib/provider-host/core/monitoring";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";

/** Every step the core takes, in the order it took them, across the tunnel, the factory and the provider. */
let steps: string[] = [];
/** The connection, options and execution context of each one-shot open (`openEngineOnce`), one entry per call. */
let created: unknown[][] = [];
/** The provider each one-shot open answers, built and not connected, as a legacy record's open answers it. */
let built: DatabaseProvider;
/** The open single-writer handle `findOpenSingleWriterProvider` answers, or null. */
let borrowed: DatabaseProvider | null = null;
/** Whether a handle of any posture holds the file. */
let fileOpen = false;
/** What the one-shot open waits for before it answers; settled unless a case holds the build. */
let building: Promise<void> = Promise.resolve();

const findOpenSingleWriterProvider = mock((connection: unknown, allowExternalFileAccess: boolean) => {
  void connection;
  void allowExternalFileAccess;
  return borrowed;
});
const getOrCreateProvider = mock(async () => built);

mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: async (
    connection: DatabaseConnection,
    run: (effective: DatabaseConnection) => Promise<unknown>,
  ) => {
    steps.push("tunnel open");
    try {
      return await run({ ...connection, host: "127.0.0.1", port: 40001 });
    } finally {
      steps.push("tunnel close");
    }
  },
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen: () => fileOpen,
  getOrCreateProvider,
  // Test Connection opens every engine through it; every case here tests a legacy engine, whose open answers the
  // provider built and not connected.
  openEngineOnce: async (
    connection: unknown,
    _engine: unknown,
    execution: unknown,
    _within: unknown,
    options: unknown,
  ): Promise<{ form: "provider"; provider: DatabaseProvider }> => {
    created.push([connection, options, execution]);
    steps.push("create");
    await building;
    return { form: "provider", provider: built };
  },
}));

const core = await import("@/lib/api/test-connection");

/** The core's test of `tested`, handed the server catalog's record of its type as both callers hand it. */
function testConnection(tested: DatabaseConnection, context: EditorExecutionContext, label: string, now?: number) {
  return core.testConnection(tested, servedEngineRecord(tested.type), context, label, now);
}

// The health read goes through the process's host core (src/lib/provider-host/instance.ts), so this file composes its
// own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

interface RecordingSteps {
  connect?: () => Promise<void>;
  getHealth?: () => Promise<unknown>;
  disconnect?: () => Promise<void>;
  connectWarnings?: () => QueryWarning[];
  testConnectionWarnings?: () => Promise<unknown>;
}

/** A provider whose every step pushes its own name onto `steps` before it does what `over` says. */
function recording(over: RecordingSteps = {}): DatabaseProvider {
  const step =
    <T>(name: string, run: () => Promise<T> | T) =>
    () => {
      steps.push(name);
      return run();
    };
  const provider = Object.assign(createMockProvider(), {
    connect: mock(step("connect", over.connect ?? (async () => {}))),
    getHealth: mock(step("getHealth", over.getHealth ?? (async () => ({})))),
    disconnect: mock(step("disconnect", over.disconnect ?? (async () => {}))),
  });
  if (over.connectWarnings) Object.assign(provider, { connectWarnings: step("connectWarnings", over.connectWarnings) });
  if (over.testConnectionWarnings) {
    Object.assign(provider, { testConnectionWarnings: step("testConnectionWarnings", over.testConnectionWarnings) });
  }
  return provider;
}

const connection: DatabaseConnection = {
  id: "c1",
  name: "c1",
  type: "postgres",
  host: "db",
  port: 5432,
  database: "app",
} as DatabaseConnection;
const execution = { allowExternalFileAccess: true } as EditorExecutionContext;
const route = "test-route";
const tunnelled = { ...connection, host: "127.0.0.1", port: 40001 };
/** A connection of an engine whose record grants a single-writer file (`grants.singleWriterFile`). */
const singleWriter = { ...connection, type: "duckdb", database: "/data/held.duckdb" } as DatabaseConnection;
const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

beforeEach(() => {
  steps = [];
  created = [];
  borrowed = null;
  fileOpen = false;
  building = Promise.resolve();
  findOpenSingleWriterProvider.mockClear();
  getOrCreateProvider.mockClear();
});

describe("testConnection", () => {
  let errorLog: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    errorLog?.mockRestore();
    errorLog = undefined;
  });

  test("runs the row's steps in order through the tunnel, answers the cautions, and caches nothing", async () => {
    built = recording({
      connectWarnings: () => [{ message: "a" }],
      testConnectionWarnings: async () => [{ message: "b" }],
    });
    const answer = await testConnection(connection, execution, route);
    expect(steps).toEqual([
      "tunnel open",
      "create",
      "connect",
      "connectWarnings",
      "testConnectionWarnings",
      "getHealth",
      "disconnect",
      "tunnel close",
    ]);
    expect(created).toEqual([[tunnelled, { queryTimeout: 10000 }, execution]]);
    expect(answer).toEqual({
      success: true,
      message: "Connection successful",
      latency: expect.any(Number),
      warnings: [{ message: "a" }, { message: "b" }],
    });
    expect(getOrCreateProvider).not.toHaveBeenCalled();
  });

  test("answers no warnings key when there are no cautions", async () => {
    built = recording();
    const answer = await testConnection(connection, execution, route);
    expect(answer).toEqual({ success: true, message: "Connection successful", latency: expect.any(Number) });
    expect("warnings" in answer).toBe(false);
  });

  test("a failed health read after a connect is a degraded success carrying the server's sentence", async () => {
    built = recording({
      getHealth: async () => {
        throw new Error("Keyspace system_views does not exist");
      },
    });
    const answer = await testConnection(connection, execution, route);
    expect(answer).toEqual({
      success: true,
      degraded: true,
      message: "Connected, but this server answered no health data: Keyspace system_views does not exist",
    });
    expect(callsOf(built.disconnect)).toHaveLength(1);
    expect(steps.slice(-2)).toEqual(["disconnect", "tunnel close"]);
  });

  test("a health rejection that is not an Error is written as a string", async () => {
    built = recording({
      getHealth: () => Promise.reject("plain"),
    });
    const answer = await testConnection(connection, execution, route);
    expect(answer.message).toEndWith(": plain");
  });

  test("checks that reject are logged under the caller's route and answered as one caution", async () => {
    const thatError = new Error("probe broke");
    built = recording({
      testConnectionWarnings: async () => {
        throw thatError;
      },
    });
    errorLog = spyOn(logger, "error").mockImplementation(() => {});
    const answer = await testConnection(connection, execution, route);
    expect(errorLog).toHaveBeenCalledWith("Test Connection checks rejected", thatError, {
      route: "test-route",
      provider: "postgres",
    });
    expect(answer.warnings).toEqual([
      {
        message:
          "The extra checks Test Connection runs for this connection did not finish, so a caution they would give may be missing.",
      },
    ]);
  });

  describe("provider text that holds the connection's credential", () => {
    const password = crypto.randomUUID();
    const holding = { ...connection, password } as DatabaseConnection;

    test("a health failure that holds the connection's credential answers a degraded success with the withheld sentence", async () => {
      built = recording({
        getHealth: async () => {
          throw new ConnectionError(`health read as ${password} failed`, "postgres");
        },
      });
      const answer = await testConnection(holding, execution, route);
      expect(answer).toEqual({
        success: true,
        degraded: true,
        message: `Connected, but this server answered no health data: ${withheldErrorMessage("ConnectionError")}`,
      });
      expect(answer.message).not.toContain(password);
    });

    test("cautions that hold the credential are withheld", async () => {
      built = recording({
        connectWarnings: () => [{ message: `a startup notice about ${password}` }, { message: "a clean notice" }],
        testConnectionWarnings: async () => [
          { message: "a probe caution", code: `P-${password}`, severity: "WARNING" },
        ],
      });
      const answer = await testConnection(holding, execution, route);
      expect(answer.warnings).toEqual([
        { message: PROVIDER_TEXT_WITHHELD },
        { message: "a clean notice" },
        { message: "a probe caution", code: PROVIDER_TEXT_WITHHELD, severity: "WARNING" },
      ]);
    });

    test("a rejected check that holds the credential is logged withheld", async () => {
      built = recording({
        testConnectionWarnings: async () => {
          throw new Error(`probe as ${password} broke`);
        },
      });
      errorLog = spyOn(logger, "error").mockImplementation(() => {});
      await testConnection(holding, execution, route);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]?.[1]).toBeInstanceOf(ProviderTextWithheldError);
      expect(errorLog.mock.calls[0]?.[2]).toEqual({ route: "test-route", provider: "postgres" });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(password);
    });
  });

  test("checks that resolve something other than an array get the same caution", async () => {
    built = recording({ testConnectionWarnings: async () => "not an array" });
    errorLog = spyOn(logger, "error").mockImplementation(() => {});
    const answer = await testConnection(connection, execution, route);
    expect(answer.warnings).toEqual([
      {
        message:
          "The extra checks Test Connection runs for this connection did not finish, so a caution they would give may be missing.",
      },
    ]);
  });

  test("a connect deadline rejects with a ConnectionError naming the wait, after the provider is closed", async () => {
    built = recording({
      connect: async () => {
        throw new TimeoutError("timed out", "postgres");
      },
    });
    const caught = await testConnection(connection, execution, route).catch((error) => error);
    expect(caught).toBeInstanceOf(ConnectionError);
    expect((caught as Error).message).toMatch(/^The connection got no answer after /);
    expect(steps).toEqual(["tunnel open", "create", "connect", "disconnect", "tunnel close"]);
    expect(callsOf(built.getHealth)).toHaveLength(0);
  });

  test("a failed disconnect after a failed connect is swallowed, so the connect's error is the answer", async () => {
    built = recording({
      connect: async () => {
        throw new Error("refused");
      },
      disconnect: async () => {
        throw new Error("already closed");
      },
    });
    await expect(testConnection(connection, execution, route)).rejects.toThrow("refused");
  });

  describe("the test's deadline, its engine's connect budget", () => {
    /** The test's sentence for a test its engine's budget of `seconds` ended. */
    const SENTENCE = (seconds: number) =>
      `The connection test got no answer within ${seconds} seconds: check the address, the port, the network path and that the server is running.`;
    /** A `now` that puts the deadline of an engine with budget `budgetMs` `aheadMs` from now. */
    const deadlineIn = (aheadMs: number, budgetMs = 70_000) => Date.now() - budgetMs + aheadMs;
    /** A `now` so far back that the budget of any engine had passed before the test started. */
    const passed = () => Date.now() - 400_000;
    /** Resolves once `condition` holds, read after each turn of the event loop, never a timer. */
    async function until(condition: () => boolean, what: string): Promise<void> {
      for (let turn = 0; !condition(); turn += 1) {
        if (turn === 1_000) throw new Error(`${what} did not happen within 1000 turns of the event loop`);
        // oxlint-disable-next-line no-await-in-loop -- each turn reads the condition again after what it let run.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    /** A disconnect that records its step and resolves `closed` when it runs. */
    function closing() {
      const closed = Promise.withResolvers<void>();
      return {
        closed: closed.promise,
        disconnect: async () => {
          closed.resolve();
        },
      };
    }

    test("a connect still pending at the engine's connect budget rejects with the test's ConnectionError, and its provider is closed once the connect settles", async () => {
      const pending = Promise.withResolvers<void>();
      const close = closing();
      built = recording({ connect: () => pending.promise, disconnect: close.disconnect });

      const caught = await testConnection(connection, execution, route, deadlineIn(30)).catch(
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).toBe(SENTENCE(70));
      await until(() => steps.includes("tunnel close"), "the tunnel's close");
      expect(steps).toEqual(["tunnel open", "create", "connect", "tunnel close"]);
      pending.resolve();
      await close.closed;
      expect(steps).toEqual(["tunnel open", "create", "connect", "tunnel close", "disconnect"]);
      expect(callsOf(built.getHealth)).toHaveLength(0);
    });

    test("a connect that fails after the deadline gets its provider closed too, and its failure goes nowhere", async () => {
      const pending = Promise.withResolvers<void>();
      const close = closing();
      built = recording({ connect: () => pending.promise, disconnect: close.disconnect });

      const caught = await testConnection(connection, execution, route, deadlineIn(30)).catch(
        (error: unknown) => error,
      );

      expect((caught as Error).message).toBe(SENTENCE(70));
      pending.reject(new Error("refused"));
      await close.closed;
      expect(steps.at(-1)).toBe("disconnect");
    });

    test("a deadline that passed while the tunnel opened builds nothing", async () => {
      built = recording();

      const caught = await testConnection(connection, execution, route, passed()).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).toBe(SENTENCE(70));
      await until(() => steps.includes("tunnel close"), "the tunnel's close");
      expect(steps).toEqual(["tunnel open", "tunnel close"]);
      expect(created).toHaveLength(0);
    });

    test("a deadline that passed while the provider was built starts no connect, and closes what was built", async () => {
      const build = Promise.withResolvers<void>();
      building = build.promise;
      const close = closing();
      built = recording({ disconnect: close.disconnect });

      const caught = await testConnection(connection, execution, route, deadlineIn(30)).catch(
        (error: unknown) => error,
      );

      expect((caught as Error).message).toBe(SENTENCE(70));
      build.resolve();
      await close.closed;
      await until(() => steps.includes("tunnel close"), "the tunnel's close");
      expect(steps).toEqual(["tunnel open", "create", "disconnect", "tunnel close"]);
    });

    test("checks or a health read still pending at the deadline answer the test's ConnectionError, never a caution or a degraded success", async () => {
      const checks = closing();
      built = recording({
        testConnectionWarnings: () => new Promise<never>(() => {}),
        disconnect: checks.disconnect,
      });
      const inChecks = await testConnection(connection, execution, route, deadlineIn(30)).catch(
        (error: unknown) => error,
      );
      expect(inChecks).toBeInstanceOf(ConnectionError);
      expect((inChecks as Error).message).toBe(SENTENCE(70));
      await checks.closed;
      await until(() => steps.includes("tunnel close"), "the tunnel's close");
      // A provider already connected is closed at once, before the tunnel it runs over.
      expect(steps).toEqual([
        "tunnel open",
        "create",
        "connect",
        "testConnectionWarnings",
        "disconnect",
        "tunnel close",
      ]);

      steps = [];
      const health = closing();
      built = recording({ getHealth: () => new Promise<never>(() => {}), disconnect: health.disconnect });
      const inHealth = await testConnection(connection, execution, route, deadlineIn(30)).catch(
        (error: unknown) => error,
      );
      expect(inHealth).toBeInstanceOf(ConnectionError);
      expect((inHealth as Error).message).toBe(SENTENCE(70));
      await health.closed;
      await until(() => steps.includes("tunnel close"), "the tunnel's close");
      expect(steps).toEqual(["tunnel open", "create", "connect", "getHealth", "disconnect", "tunnel close"]);
    });

    test("a health read whose deadline passed before its timer fired answers the test's ConnectionError and reads no health", async () => {
      const now = deadlineIn(30);
      const deadline = now + connectBudgetFor("postgres");
      // The connect holds the thread until the clock is past the deadline, and every later step runs as a microtask,
      // so the deadline's timer has not fired when the health read starts: only the read's own refusal answers.
      built = recording({
        connect: async () => {
          while (Date.now() <= deadline + 5) {
            // Spins on the clock by design: a timer here would let the deadline's own timer fire first.
          }
        },
      });

      const caught = await testConnection(connection, execution, route, now).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).toBe(SENTENCE(70));
      expect(callsOf(built.getHealth)).toEqual([]);
      expect(steps).toEqual(["tunnel open", "create", "connect", "disconnect", "tunnel close"]);
    });

    test("the deadline names the engine's own budget", async () => {
      const pending = Promise.withResolvers<void>();
      built = recording({ connect: () => pending.promise });
      const bigquery = { ...connection, type: "bigquery" } as DatabaseConnection;

      const caught = await testConnection(bigquery, execution, route, deadlineIn(30, 140_000)).catch(
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).toBe(SENTENCE(140));
      expect((caught as ConnectionError).provider).toBe("bigquery");
      pending.resolve();
    });

    test("the health read is one host core health call on the bridged session of the provider the test holds, under the test's own deadline", async () => {
      const calls: { session: HealthSession; ctx: CallContext }[] = [];
      const real = hostCore();
      const spying: HostCore = {
        ...real,
        healthCall: (session, ctx, ports) => {
          calls.push({ session, ctx });
          return real.healthCall(session, ctx, ports);
        },
      };
      const now = Date.now();
      forgetHostCore();
      installHostCore(spying, "test");
      try {
        built = recording();
        const answer = await testConnection(connection, execution, route, now);
        expect(answer).toEqual({ success: true, message: "Connection successful", latency: expect.any(Number) });
        expect(callsOf(built.getHealth)).toEqual([[]]);

        steps = [];
        borrowed = recording();
        const borrowedAnswer = await testConnection(singleWriter, execution, route, now);
        expect(borrowedAnswer.success).toBe(true);
        expect(callsOf(borrowed.getHealth)).toEqual([[]]);
        expect(steps).toEqual(["tunnel open", "getHealth", "tunnel close"]);
      } finally {
        forgetHostCore();
        installHostCore(real, "test");
      }

      expect(calls).toHaveLength(2);
      for (const { ctx } of calls) {
        // DuckDB and PostgreSQL share the host's default budget.
        expect(ctx.deadline).toBe(now + connectBudgetFor("postgres"));
        expect(connectBudgetFor("duckdb")).toBe(connectBudgetFor("postgres"));
        expect(ctx.signal).toBeInstanceOf(AbortSignal);
        expect(ctx.signal.aborted).toBe(false);
      }
    });

    test("a health failure after the test's deadline is logged by kind and code, never its text, and the answer stays the test's ConnectionError", async () => {
      const secret = crypto.randomUUID();
      const logged = Promise.withResolvers<unknown[]>();
      const warned: unknown[][] = [];
      const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
        warned.push(args);
        logged.resolve(args);
      });
      try {
        const pending = Promise.withResolvers<never>();
        const close = closing();
        built = recording({ getHealth: () => pending.promise, disconnect: close.disconnect });

        const caught = await testConnection(connection, execution, route, deadlineIn(30)).catch(
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(ConnectionError);
        expect((caught as Error).message).toBe(SENTENCE(70));
        expect(warned).toEqual([]);
        pending.reject(new Error(secret));
        await logged.promise;
        await close.closed;
      } finally {
        warn.mockRestore();
      }

      expect(warned).toEqual([
        [
          "A monitoring read Studio stopped waiting for failed afterwards",
          { route, facet: "health", kind: "internal", code: "INTERNAL_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
    });

    test("a health read made before the host core is installed fails by name, never a degraded success, and the provider is closed", async () => {
      const real = hostCore();
      const close = closing();
      built = recording({ disconnect: close.disconnect });
      forgetHostCore();
      let caught: unknown;
      try {
        caught = await testConnection(connection, execution, route).catch((error: unknown) => error);
      } finally {
        installHostCore(real, "test");
      }

      expect(caught).toBeInstanceOf(HostCoreBootOrderError);
      await close.closed;
      expect(callsOf(built.getHealth)).toEqual([]);
      expect(steps).toEqual(["tunnel open", "create", "connect", "disconnect", "tunnel close"]);
    });

    test("a test that answers within its budget answers as before", async () => {
      built = recording();
      const answer = await testConnection(connection, execution, route);
      expect(answer.success).toBe(true);
      expect(steps).toEqual(["tunnel open", "create", "connect", "getHealth", "disconnect", "tunnel close"]);
    });
  });

  test("a borrowed single-writer handle is read for health and never created, checked or closed", async () => {
    built = recording();
    steps = [];
    borrowed = recording({ testConnectionWarnings: async () => [{ message: "never" }] });
    // DuckDB's record grants a single-writer file, so only such an engine's test looks for a handle to borrow.
    const answer = await testConnection(singleWriter, execution, route);
    expect(callsOf(findOpenSingleWriterProvider)).toEqual([
      [{ ...singleWriter, host: "127.0.0.1", port: 40001 }, true],
    ]);
    expect(steps).toEqual(["tunnel open", "getHealth", "tunnel close"]);
    expect(answer).toEqual({ success: true, message: "Connection successful", latency: expect.any(Number) });
  });

  test("beside a writer of the other posture the test handle opens read-only", async () => {
    built = recording();
    fileOpen = true;
    await testConnection(singleWriter, execution, route);
    expect(created[0][2]).toEqual({ readOnly: true });
  });

  test("an engine whose record grants no single-writer file never looks for a handle to borrow", async () => {
    built = recording();
    borrowed = recording();
    fileOpen = true;
    await testConnection(connection, execution, route);
    expect(callsOf(findOpenSingleWriterProvider)).toEqual([]);
    expect(created[0][2]).toBe(execution);
  });

  test("a connection its engine's field rules refuse is refused with the rule's sentence before the tunnel opens or anything is built, and its statement was not sent", async () => {
    built = recording();
    // An IPv4 address is not a Snowflake account, which Snowflake's declared Account check refuses, and the tunnel is
    // on, so a tunnel dialled before the refusal would show in the steps.
    const refused = {
      id: "sf",
      name: "sf",
      type: "snowflake",
      host: "1.2.3.4",
      user: "analyst",
      role: "analyst",
      authMethod: "pat",
      password: crypto.randomUUID(),
      sshTunnel: { enabled: true, host: "bastion.example.com", port: 22, username: "jump", authMethod: "password" },
      createdAt: new Date(0),
    } as DatabaseConnection;
    let thrown: unknown;
    try {
      await testConnection(refused, execution, route);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseConfigError);
    const sentence = snowflakeAccountRefusal("1.2.3.4");
    expect(sentence).toBeString();
    expect((thrown as DatabaseConfigError).message).toBe(sentence as string);
    expect((thrown as DatabaseConfigError).provider).toBe("snowflake");
    expect((thrown as DatabaseConfigError).outcome).toBe("not-sent");
    expect(steps).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe("the core's import closure stays free of Next", () => {
  // The VS Code extension's backend child runs this module outside Next. It reaches the drivers through
  // the factory, so packages are allowed; Next, query events and governance are not.
  test("no value import in the closure reaches next, query events or governance", () => {
    const closure = valueImportClosure("src/lib/api/test-connection.ts");
    expect(closure.unresolved).toEqual([]);
    expect(serverOnlyReach(closure)).toEqual([]);
    // A control on the walk: the modules this core imports by value, and the providers behind the factory.
    expect(closure.modules).toEqual(
      expect.arrayContaining([
        "src/lib/db/factory.ts",
        "src/lib/db/errors.ts",
        "src/lib/logger.ts",
        "src/lib/api/provider-monitoring.ts",
        "src/lib/provider-host/instance.ts",
        "src/lib/db/providers/sql/postgres.ts",
      ]),
    );
  });

  test("a control: the same walk over the Test Connection route finds Next", () => {
    expect(serverOnlyReach(valueImportClosure("src/app/api/db/test-connection/route.ts"))).toContain("next/server");
  });
});
