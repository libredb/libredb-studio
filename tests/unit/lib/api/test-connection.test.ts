import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ConnectionError, TimeoutError } from "@/lib/db/errors";
import type { DatabaseProvider, EditorExecutionContext } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { serverOnlyReach, valueImportClosure } from "../../../helpers/value-import-closure";

/** Every step the core takes, in the order it took them, across the tunnel, the factory and the provider. */
let steps: string[] = [];
/** The arguments `createDatabaseProvider` was called with, one entry per call. */
let created: unknown[][] = [];
/** The provider `createDatabaseProvider` hands back. */
let built: DatabaseProvider;
/** The open single-writer handle `findOpenSingleWriterProvider` answers, or null. */
let borrowed: DatabaseProvider | null = null;
/** Whether a handle of any posture holds the file. */
let fileOpen = false;

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
  createDatabaseProvider: async (...args: unknown[]) => {
    created.push(args);
    steps.push("create");
    return built;
  },
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen: () => fileOpen,
  getOrCreateProvider,
}));

const { testConnection } = await import("@/lib/api/test-connection");

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
const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

beforeEach(() => {
  steps = [];
  created = [];
  borrowed = null;
  fileOpen = false;
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

  describe("the caller's signal", () => {
    /** Lets the core run up to the connect it awaits. */
    const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    test("an abort during the connect rejects at once with its reason and closes the tunnel, and the provider is closed once the connect settles", async () => {
      const pending = Promise.withResolvers<void>();
      built = recording({ connect: () => pending.promise });
      const stop = new AbortController();
      const reason = new ConnectionError("The connection test got no answer within 11 seconds.", "postgres");
      const answer = testConnection(connection, execution, route, stop.signal).catch((error: unknown) => error);
      await turn();
      expect(steps).toEqual(["tunnel open", "create", "connect"]);
      stop.abort(reason);
      expect(await answer).toBe(reason);
      expect(steps).toEqual(["tunnel open", "create", "connect", "tunnel close"]);
      pending.resolve();
      await turn();
      expect(steps).toEqual(["tunnel open", "create", "connect", "tunnel close", "disconnect"]);
      expect(callsOf(built.getHealth)).toHaveLength(0);
    });

    test("a connect that fails after the abort gets its provider closed too, and its failure goes nowhere", async () => {
      const pending = Promise.withResolvers<void>();
      built = recording({ connect: () => pending.promise });
      const stop = new AbortController();
      const answer = testConnection(connection, execution, route, stop.signal).catch((error: unknown) => error);
      await turn();
      stop.abort(new Error("deadline"));
      expect(((await answer) as Error).message).toBe("deadline");
      pending.reject(new Error("refused"));
      await turn();
      expect(steps.at(-1)).toBe("disconnect");
    });

    test("a signal that aborted before the tunnel's callback ran builds nothing", async () => {
      built = recording();
      const stop = new AbortController();
      const reason = new Error("deadline");
      stop.abort(reason);
      expect(await testConnection(connection, execution, route, stop.signal).catch((error: unknown) => error)).toBe(
        reason,
      );
      expect(steps).toEqual(["tunnel open", "tunnel close"]);
      expect(created).toHaveLength(0);
    });

    test("a signal that never aborts changes nothing", async () => {
      built = recording();
      const answer = await testConnection(connection, execution, route, new AbortController().signal);
      expect(answer.success).toBe(true);
      expect(steps).toEqual(["tunnel open", "create", "connect", "getHealth", "disconnect", "tunnel close"]);
    });
  });

  test("a borrowed single-writer handle is read for health and never created, checked or closed", async () => {
    built = recording();
    steps = [];
    borrowed = recording({ testConnectionWarnings: async () => [{ message: "never" }] });
    const answer = await testConnection(connection, execution, route);
    expect(callsOf(findOpenSingleWriterProvider)).toEqual([[tunnelled, true]]);
    expect(steps).toEqual(["tunnel open", "getHealth", "tunnel close"]);
    expect(answer).toEqual({ success: true, message: "Connection successful", latency: expect.any(Number) });
  });

  test("beside a writer of the other posture the test handle opens read-only", async () => {
    built = recording();
    fileOpen = true;
    await testConnection(connection, execution, route);
    expect(created[0][2]).toEqual({ readOnly: true });
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
        "src/lib/db/providers/sql/postgres.ts",
      ]),
    );
  });

  test("a control: the same walk over the Test Connection route finds Next", () => {
    expect(serverOnlyReach(valueImportClosure("src/app/api/db/test-connection/route.ts"))).toContain("next/server");
  });
});
