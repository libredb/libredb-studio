/**
 * The session registry over the fake Spark Connect server: one session per scope and a new one per statement without a
 * scope; the setup in its order, the catalog as a string literal and the namespace through USE NAMESPACE; the metadata
 * session's extra settings, and nothing on it but its setup; observed server-side ids; a failed setup failing only the
 * statement that needed it, never the setup that replaced it; releases that never throw; the registry closed after
 * releaseAll, so nothing is set up again; the metadata session repeated once after the server closed it, for each of
 * the three INVALID_HANDLE classes, and discarded once when two reads meet it together; a metadata setup discarded in
 * flight released once it settles; the repeat only for a failure the read mapped to a SparkError, never for the
 * channel's own error; a setup in flight when releaseAll begins sending no further step, and a metadata read whose
 * setup answers then sending nothing; close doing the same at once, sending nothing itself and leaving the releases to
 * releaseAll; the wait and the read told whether they serve the repeat; both setup statements given the moment the
 * setup began.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SPARK_METADATA_SESSION_CONF, SPARK_SESSION_CONF } from "@/lib/db/providers/sql/spark/constants";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import { SPARK_ERROR_SENTENCES, SparkError, toSparkError } from "@/lib/db/providers/sql/spark/errors";
import { grpcWireTransport, type SparkWireChannel } from "@/lib/db/providers/sql/spark/grpc-client";
import {
  configGetOptionRequest,
  configSetRequest,
  releaseSessionRequest,
  type SparkSessionRef,
  sqlCommandRequest,
  versionRequest,
} from "@/lib/db/providers/sql/spark/requests";
import {
  type SparkSessionDeps,
  type SparkSessionHandle,
  type SparkSessionPlace,
  SparkSessions,
} from "@/lib/db/providers/sql/spark/session";
import type { DatabaseConnection } from "@/lib/types";
import { type SparkFakeAnswer, type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";

const OK: SparkFakeAnswer = { kind: "command", ipc: new Uint8Array([0]) };
const statements: Record<string, SparkFakeAnswer> = {
  "SET CATALOG 'spark_catalog'": OK,
  "SET CATALOG 'my\\'cat'": OK,
  "USE NAMESPACE `studio`": OK,
  "USE NAMESPACE `a.b`.`c``d`": OK,
  "SHOW NAMESPACES": OK,
};
let fake: SparkFakeServer;
let channel: SparkWireChannel;
const call = () => ({ metadata: {}, deadline: new Date(Date.now() + 5_000), signal: new AbortController().signal });
const LIMITS = { maxReceivedBytes: 33_554_432 };

/** One statement on `session` over the fake, read to its end; answers the server-side id its answer carried. */
async function runStatement(session: SparkSessionRef, sql: string): Promise<string> {
  const run = { operationId: randomUUID(), tag: `libredb-studio-${randomUUID()}` };
  const stream = channel.executePlan(sqlCommandRequest(session, sql, run), call(), LIMITS);
  let id = "";
  // oxlint-disable-next-line no-await-in-loop -- one reader awaits each message before it asks for the next.
  for (let response = await stream.read(); response !== undefined; response = await stream.read()) {
    id ||= (response as { server_side_session_id?: string }).server_side_session_id ?? "";
  }
  return id;
}

const deps = (overrides: Partial<SparkSessionDeps> = {}): SparkSessionDeps => ({
  configSet: async (session, pairs) =>
    ((await channel.unary("Config", configSetRequest(session, pairs), call())) as { server_side_session_id: string })
      .server_side_session_id,
  runSetup: runStatement,
  release: async (session) => {
    await channel.unary("ReleaseSession", releaseSessionRequest(session), call());
  },
  ...overrides,
});
const PLACE: SparkSessionPlace = { catalog: "spark_catalog", namespace: ["studio"] };
const entriesOf = (sessionId: string) => fake.log.entries.filter((entry) => entry.sessionId === sessionId);
const releasesOf = (sessionId?: string) =>
  fake.log.entries.filter(
    (entry) => entry.rpc === "ReleaseSession" && (sessionId === undefined || entry.sessionId === sessionId),
  );
const setupOf = (sessionId: string) =>
  entriesOf(sessionId).map((entry) =>
    entry.rpc === "Config"
      ? (entry.request as { operation: { set: { pairs: { key: string; value: string }[] } } }).operation.set.pairs.map(
          (pair) => [pair.key, pair.value],
        )
      : (entry.request as { plan: { command: { sql_command: { input: { sql: { query: string } } } } } }).plan.command
          .sql_command.input.sql.query,
  );
/** Every call the fake received, in order, with its session: an ExecutePlan by its statement, a Config set or read. */
const received = () =>
  fake.log.entries.map((entry) => {
    const { plan, operation } = entry.request as {
      plan?: { command: { sql_command: { input: { sql: { query: string } } } } };
      operation?: { set?: unknown };
    };
    if (entry.rpc === "ExecutePlan") return [entry.sessionId, plan?.command.sql_command.input.sql.query];
    if (entry.rpc !== "Config") return [entry.sessionId, entry.rpc];
    return [entry.sessionId, operation?.set === null || operation?.set === undefined ? "Config read" : "Config set"];
  });
/** A failure mapped as the provider maps a control call's. */
const sparkErrorOf = (error: unknown) =>
  toSparkError(error, { connection: { host: "h", port: 1, secretForms: [] }, phase: "control" });
/** A metadata read over the fake: one Config get_option on the session it is given. */
const configRead = (seen: string[]) => async (session: SparkSessionRef) => {
  seen.push(session.sessionId);
  try {
    await channel.unary("Config", configGetOptionRequest(session, ["k"]), call());
  } catch (error) {
    throw sparkErrorOf(error);
  }
  return 42;
};

beforeAll(async () => {
  fake = await startSparkFake({ statements });
  const port = Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
  channel = grpcWireTransport(
    buildSparkConnectionOptions(
      { id: "c", name: "c", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
      { queryTimeout: 5_000 },
    ),
  );
});
afterAll(() => {
  channel.close();
  fake.close();
});
beforeEach(() => {
  fake.log.clear();
  statements["SET CATALOG 'spark_catalog'"] = OK;
  statements["SHOW NAMESPACES"] = OK;
});

describe("sessions by scope", () => {
  test("one handle per scope, another per other scope, and a new statement session for each unscoped call", async () => {
    const sessions = new SparkSessions(deps(), {});
    const a = await sessions.forScope("a");
    expect(await sessions.forScope("a")).toBe(a);
    const b = await sessions.forScope("b");
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(a.kind).toBe("request");
    const first = await sessions.forScope(undefined);
    const second = await sessions.forScope(undefined);
    expect(first.kind).toBe("statement");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(sessions.openCount()).toBe(4);
    await sessions.releaseAll();
    expect(sessions.openCount()).toBe(0);
  });

  test("two statements of one scope that ask at once share one setup", async () => {
    const sessions = new SparkSessions(deps(), {});
    const [x, y] = await Promise.all([sessions.forScope("c"), sessions.forScope("c")]);
    expect(y).toBe(x);
    expect(fake.log.entries.filter((entry) => entry.rpc === "Config")).toHaveLength(1);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  test("the setup in its order: the seven settings, SET CATALOG as a string literal, then USE NAMESPACE", async () => {
    const sessions = new SparkSessions(deps(), PLACE);
    const handle = await sessions.forScope("s");
    const statement = await sessions.forScope(undefined);
    const expected = [
      SPARK_SESSION_CONF.map(([key, value]) => [key, value]),
      "SET CATALOG 'spark_catalog'",
      "USE NAMESPACE `studio`",
    ];
    expect(setupOf(handle.sessionId)).toStrictEqual(expected);
    // A statement session is set up as a request session is: neither gets the metadata session's two settings.
    expect(setupOf(statement.sessionId)).toStrictEqual(expected);
    expect(typeof handle.serverSideSessionId).toBe("string");
    await sessions.releaseAll();
  });

  test("both setup statements are given the moment the setup began, taken before the Config set", async () => {
    let clock = 5_000;
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const given: (readonly [string, number])[] = [];
    try {
      const sessions = new SparkSessions(
        {
          // The Config set takes 2 s of the clock, and each setup statement 3 s.
          configSet: async () => {
            clock += 2_000;
            return "";
          },
          runSetup: async (_session, sql, setupStart) => {
            given.push([sql, setupStart]);
            clock += 3_000;
            return "";
          },
          release: async () => undefined,
        },
        PLACE,
      );
      await sessions.forScope("timed");
      expect(given).toStrictEqual([
        ["SET CATALOG 'spark_catalog'", 5_000],
        ["USE NAMESPACE `studio`", 5_000],
      ]);
      await sessions.releaseAll();
    } finally {
      now.mockRestore();
    }
  });

  test("a catalog with a quote is a backslash-escaped literal and every namespace part is quoted", async () => {
    const sessions = new SparkSessions(deps(), { catalog: "my'cat", namespace: ["a.b", "c`d"] });
    const handle = await sessions.forScope("q");
    expect(setupOf(handle.sessionId).slice(1)).toStrictEqual(["SET CATALOG 'my\\'cat'", "USE NAMESPACE `a.b`.`c``d`"]);
    await sessions.releaseAll();
  });

  test("the metadata session gets both settings lists in one call, and is one handle until discarded, unreleased", async () => {
    const sessions = new SparkSessions(deps(), {});
    const metadata = await sessions.metadata();
    expect(metadata.kind).toBe("metadata");
    expect(await sessions.metadata()).toBe(metadata);
    expect(setupOf(metadata.sessionId)).toStrictEqual([
      [...SPARK_SESSION_CONF, ...SPARK_METADATA_SESSION_CONF].map(([key, value]) => [key, value]),
    ]);
    sessions.discardMetadata();
    expect(sessions.openCount()).toBe(0);
    const fresh = await sessions.metadata();
    expect(fresh.sessionId).not.toBe(metadata.sessionId);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
    // The server closed the session it discards, so the discard drops it and never releases it.
    expect(releasesOf().map((entry) => entry.sessionId)).toStrictEqual([fresh.sessionId]);
  });

  test("the metadata session takes the connection's catalog and namespace too", async () => {
    const sessions = new SparkSessions(deps(), PLACE);
    const metadata = await sessions.metadata();
    expect(setupOf(metadata.sessionId)).toStrictEqual([
      [...SPARK_SESSION_CONF, ...SPARK_METADATA_SESSION_CONF].map(([key, value]) => [key, value]),
      "SET CATALOG 'spark_catalog'",
      "USE NAMESPACE `studio`",
    ]);
    await sessions.releaseAll();
  });

  test("no user text reaches the metadata session: it carries its setup only, the statements their own sessions", async () => {
    const sessions = new SparkSessions(deps(), PLACE);
    const metadata = await sessions.metadata();
    const request = await sessions.forScope("u");
    const statement = await sessions.forScope(undefined);
    await runStatement(request, "SHOW NAMESPACES");
    await runStatement(statement, "SHOW NAMESPACES");
    const place = ["SET CATALOG 'spark_catalog'", "USE NAMESPACE `studio`"];
    expect(setupOf(metadata.sessionId)).toStrictEqual([
      [...SPARK_SESSION_CONF, ...SPARK_METADATA_SESSION_CONF].map(([key, value]) => [key, value]),
      ...place,
    ]);
    const user = [SPARK_SESSION_CONF.map(([key, value]) => [key, value]), ...place, "SHOW NAMESPACES"];
    expect(setupOf(request.sessionId)).toStrictEqual(user);
    expect(setupOf(statement.sessionId)).toStrictEqual(user);
    await sessions.releaseAll();
  });
});

describe("a failed setup fails only the statement that needed it", () => {
  test("the scope's next statement starts a new session, the failed one is released, and other scopes are untouched", async () => {
    statements["SET CATALOG 'spark_catalog'"] = {
      kind: "error",
      code: 13,
      message: "[CATALOG_NOT_FOUND] The catalog `spark_catalog` is not found.",
      errorInfo: { errorClass: "CATALOG_NOT_FOUND", sqlState: "42P08" },
    };
    const sessions = new SparkSessions(deps(), PLACE);
    const failed = await sessions.forScope("x").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain("[CATALOG_NOT_FOUND]");
    const released = releasesOf();
    expect(released).toHaveLength(1);
    expect(sessions.openCount()).toBe(0);
    statements["SET CATALOG 'spark_catalog'"] = OK;
    const retried = await sessions.forScope("x");
    expect(retried.sessionId).not.toBe(released[0]?.sessionId);
    expect((await sessions.forScope("y")).sessionId).not.toBe(retried.sessionId);
    await sessions.releaseAll();
  });

  test("the failure is the deps' own error, for a statement session and for a metadata read, and nothing stays open", async () => {
    const refused = new Error("refused");
    let refuse = true;
    const sessions = new SparkSessions(
      deps({ configSet: (session, pairs) => (refuse ? Promise.reject(refused) : deps().configSet(session, pairs)) }),
      {},
    );
    const statement = await sessions.forScope(undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(statement).toBe(refused);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return reads;
    };
    const metadata = await sessions.readMetadata(read).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(metadata).toBe(refused);
    expect(reads).toBe(0);
    expect(sessions.openCount()).toBe(0);
    expect(releasesOf()).toHaveLength(2);
    // The failed metadata setup left nothing behind: the next read sets up a new metadata session.
    refuse = false;
    expect(await sessions.readMetadata(read)).toBe(1);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  /** Deps whose first setup sends its Config set, then fails once `hold` resolves; every later setup succeeds. */
  const firstSetupFails = (asked: string[], hold: Promise<void>) =>
    deps({
      configSet: async (session, pairs) => {
        asked.push(session.sessionId);
        const id = await deps().configSet(session, pairs);
        if (asked[0] !== session.sessionId) return id;
        await hold;
        throw new SparkError("spark", "the old setup failed");
      },
    });

  test("a scope ended and asked for again while its old setup is failing keeps the new session", async () => {
    const hold = Promise.withResolvers<void>();
    const asked: string[] = [];
    const sessions = new SparkSessions(firstSetupFails(asked, hold.promise), {});
    const oldFailure = sessions.forScope("k").then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    const ended = sessions.endScope("k");
    const renewed = await sessions.forScope("k");
    hold.resolve();
    expect(await oldFailure).toBe("the old setup failed");
    await ended;
    expect(await sessions.forScope("k")).toBe(renewed);
    // One Config set per setup, and the one release is the failed setup's own.
    expect(asked).toStrictEqual([asked[0], renewed.sessionId]);
    expect(fake.log.entries.filter((entry) => entry.rpc === "Config")).toHaveLength(2);
    expect(releasesOf().map((entry) => entry.sessionId)).toStrictEqual([asked[0]]);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  test("a metadata session discarded and asked for again while its old setup is failing keeps the new session", async () => {
    const hold = Promise.withResolvers<void>();
    const asked: string[] = [];
    const sessions = new SparkSessions(firstSetupFails(asked, hold.promise), {});
    const oldFailure = sessions.metadata().then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    sessions.discardMetadata();
    const renewed = await sessions.metadata();
    hold.resolve();
    expect(await oldFailure).toBe("the old setup failed");
    expect(await sessions.metadata()).toBe(renewed);
    expect(asked).toStrictEqual([asked[0], renewed.sessionId]);
    expect(fake.log.entries.filter((entry) => entry.rpc === "Config")).toHaveLength(2);
    expect(releasesOf().map((entry) => entry.sessionId)).toStrictEqual([asked[0]]);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });
});

describe("server-side ids", () => {
  test("observe records the first id, accepts it again, ignores an empty one and refuses another", async () => {
    const sessions = new SparkSessions(deps(), {});
    const handle = await sessions.forScope("o");
    const id = handle.serverSideSessionId as string;
    sessions.observe(handle, id);
    sessions.observe(handle, "");
    expect(handle.serverSideSessionId).toBe(id);
    expect(() => sessions.observe(handle, randomUUID())).toThrow(SPARK_ERROR_SENTENCES.sessionChanged);
    await sessions.releaseAll();
  });

  test("an id that first arrives after the setup is recorded then", async () => {
    const sessions = new SparkSessions(deps({ configSet: async () => "" }), {});
    const handle = await sessions.forScope("late");
    expect(handle.serverSideSessionId).toBeUndefined();
    const id = randomUUID();
    sessions.observe(handle, id);
    expect(handle.serverSideSessionId).toBe(id);
    expect(() => sessions.observe(handle, randomUUID())).toThrow(SPARK_ERROR_SENTENCES.sessionChanged);
    await sessions.releaseAll();
  });

  test("a setup step that answers another id fails the setup with the restart sentence and releases the session", async () => {
    const released: string[] = [];
    const sessions = new SparkSessions(
      {
        configSet: async () => "first",
        runSetup: async () => "second",
        release: async (session) => {
          released.push(session.sessionId);
        },
      },
      PLACE,
    );
    const changed = await sessions.forScope("m").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(changed).toBeInstanceOf(SparkError);
    expect((changed as SparkError).category).toBe("session-changed");
    expect((changed as SparkError).message).toBe(SPARK_ERROR_SENTENCES.sessionChanged);
    expect(released).toHaveLength(1);
    expect(sessions.openCount()).toBe(0);
  });

  test("a later request carries the observed id, and after a restart the server refuses it as SESSION_CHANGED", async () => {
    const sessions = new SparkSessions(deps(), {});
    const handle = await sessions.forScope("r");
    await channel.unary("Config", configGetOptionRequest(handle, ["k"]), call());
    const last = fake.log.entries.at(-1)?.request as { client_observed_server_side_session_id?: string };
    expect(last.client_observed_server_side_session_id).toBe(handle.serverSideSessionId);
    fake.restart();
    const refused = await channel.unary("Config", configGetOptionRequest(handle, ["k"]), call()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(sparkErrorOf(refused).category).toBe("session-changed");
    await sessions.releaseAll();
  });
});

describe("releases", () => {
  test("endScope releases the scope's session once; an unknown scope is nothing; a failing release never throws", async () => {
    const sessions = new SparkSessions(deps(), {});
    const handle = await sessions.forScope("e");
    await sessions.endScope("e");
    await sessions.endScope("e");
    await sessions.endScope("never");
    expect(releasesOf(handle.sessionId)).toHaveLength(1);
    const failing = new SparkSessions(deps({ release: () => Promise.reject(new Error("unreachable")) }), {});
    await failing.forScope("f");
    const statement = await failing.forScope(undefined);
    await failing.metadata();
    await failing.endScope("f");
    await failing.endStatementSession(statement);
    await failing.releaseAll();
    expect(failing.openCount()).toBe(0);
    // A release that throws before it answers a promise never throws either.
    const throwing = new SparkSessions(
      deps({
        release: () => {
          throw new Error("thrown");
        },
      }),
      {},
    );
    await throwing.forScope("t");
    const held = await throwing.forScope(undefined);
    await throwing.endStatementSession(held);
    await throwing.endScope("t");
    expect(throwing.openCount()).toBe(0);
  });

  test("endStatementSession releases the statement's session once", async () => {
    const sessions = new SparkSessions(deps(), {});
    const statement = await sessions.forScope(undefined);
    await sessions.endStatementSession(statement);
    await sessions.endStatementSession(statement);
    expect(releasesOf()).toHaveLength(1);
    expect(releasesOf(statement.sessionId)).toHaveLength(1);
    expect(sessions.openCount()).toBe(0);
  });

  test("a scope whose setup failed has nothing to release at its end", async () => {
    const sessions = new SparkSessions(deps({ configSet: () => Promise.reject(new Error("refused")) }), {});
    await sessions.forScope("z").then(
      () => undefined,
      () => undefined,
    );
    await sessions.endScope("z");
    expect(sessions.openCount()).toBe(0);
    // The one release is the failed setup's own.
    expect(releasesOf()).toHaveLength(1);
  });

  test("releaseAll waits for a scope still in setup and releases it too", async () => {
    let unblock: (() => void) | undefined;
    const slow = deps({
      configSet: async (session, pairs) => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return deps().configSet(session, pairs);
      },
    });
    const sessions = new SparkSessions(slow, {});
    const pending = sessions.forScope("slow");
    await Promise.resolve();
    const released = sessions.releaseAll();
    unblock?.();
    const handle = await pending;
    await released;
    expect(sessions.openCount()).toBe(0);
    expect(releasesOf(handle.sessionId)).toHaveLength(1);
  });

  test("releaseAll waits for a statement session still in setup, so its release follows the session's Config", async () => {
    let unblock: (() => void) | undefined;
    const slow = deps({
      configSet: async (session, pairs) => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return deps().configSet(session, pairs);
      },
    });
    const sessions = new SparkSessions(slow, {});
    const pending = sessions.forScope(undefined);
    await Promise.resolve();
    const released = sessions.releaseAll();
    unblock?.();
    const handle = await pending;
    await released;
    expect(sessions.openCount()).toBe(0);
    expect(entriesOf(handle.sessionId).map((entry) => entry.rpc)).toStrictEqual(["Config", "ReleaseSession"]);
  });

  test("releaseAll answers once a release that began before it, a statement's own, has answered", async () => {
    let unblock: (() => void) | undefined;
    const sessions = new SparkSessions(
      deps({
        release: async (session) => {
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
          return deps().release(session);
        },
      }),
      {},
    );
    const handle = await sessions.forScope(undefined);
    const ending = sessions.endStatementSession(handle);
    let answered = false;
    const released = sessions.releaseAll().then(() => {
      answered = true;
    });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(answered).toBe(false);
    unblock?.();
    await Promise.all([ending, released]);
    expect(answered).toBe(true);
    expect(releasesOf(handle.sessionId)).toHaveLength(1);
  });

  test("after endScope the scope's next statement sets up a new session, not the released one", async () => {
    const sessions = new SparkSessions(deps(), {});
    const ended = await sessions.forScope("n");
    await sessions.endScope("n");
    const next = await sessions.forScope("n");
    expect(next.sessionId).not.toBe(ended.sessionId);
    expect(fake.log.entries.map((entry) => [entry.rpc, entry.sessionId])).toStrictEqual([
      ["Config", ended.sessionId],
      ["ReleaseSession", ended.sessionId],
      ["Config", next.sessionId],
    ]);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  test("a metadata read that meets the session releaseAll released is not repeated, and nothing follows the release", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    let reads = 0;
    const refused = await sessions
      .readMetadata(async () => {
        reads += 1;
        await sessions.releaseAll();
        throw new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(reads).toBe(1);
    expect(refused).toBeInstanceOf(SparkError);
    expect([(refused as SparkError).category, (refused as SparkError).message]).toStrictEqual([
      "cancelled",
      SPARK_ERROR_SENTENCES.cancelled,
    ]);
    expect(fake.log.entries.map((entry) => [entry.rpc, entry.sessionId])).toStrictEqual([
      ["Config", first.sessionId],
      ["ReleaseSession", first.sessionId],
    ]);
    expect(sessions.openCount()).toBe(0);
  });

  test("after releaseAll the registry is closed: a scope, a statement and the metadata session are refused as cancelled", async () => {
    const sessions = new SparkSessions(deps(), PLACE);
    await sessions.forScope("a");
    await sessions.metadata();
    await sessions.releaseAll();
    fake.log.clear();
    let reads = 0;
    const asked: Promise<unknown>[] = [
      sessions.forScope("a"),
      sessions.forScope("b"),
      sessions.forScope(undefined),
      sessions.metadata(),
      sessions.readMetadata(async () => {
        reads += 1;
        return reads;
      }),
    ];
    const refusals = await Promise.all(
      asked.map((promise) =>
        promise.then(
          () => undefined,
          (error: unknown) => (error instanceof SparkError ? [error.category, error.message] : error),
        ),
      ),
    );
    const cancelled = ["cancelled", SPARK_ERROR_SENTENCES.cancelled];
    expect(refusals).toStrictEqual([cancelled, cancelled, cancelled, cancelled, cancelled]);
    expect(reads).toBe(0);
    expect(fake.log.entries).toHaveLength(0);
    expect(sessions.openCount()).toBe(0);
    await sessions.endScope("a");
    await sessions.releaseAll();
    expect(fake.log.entries).toHaveLength(0);
  });
});

describe("a release that begins while a setup is in flight", () => {
  /**
   * Deps whose step `held`, the Config set or the setup statement it begins, is sent and answered as usual and then
   * handed to the registry only once the test opens it, skipping the first `after` steps it names; `reached` settles
   * once that step waits.
   */
  function heldStep(held: string, after = 0) {
    const hold = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let seen = 0;
    const handOver = async (step: string, id: string) => {
      if (!step.startsWith(held)) return id;
      seen += 1;
      if (seen <= after) return id;
      reached.resolve();
      await hold.promise;
      return id;
    };
    return {
      deps: deps({
        configSet: async (session, pairs) => handOver("Config set", await deps().configSet(session, pairs)),
        runSetup: async (session, sql) => handOver(sql, await runStatement(session, sql)),
      }),
      reached: reached.promise,
      open: () => hold.resolve(),
    };
  }
  const refusalOf = (error: unknown) =>
    error instanceof SparkError ? [error.category, error.message] : ["not a SparkError", error];
  const cancelled = ["cancelled", SPARK_ERROR_SENTENCES.cancelled];

  test.each<[string, readonly string[]]>([
    ["Config set", ["Config set", "ReleaseSession"]],
    ["SET CATALOG", ["Config set", "SET CATALOG 'spark_catalog'", "ReleaseSession"]],
  ])(
    "a setup whose %s answers once releaseAll began sends no further step, is refused as cancelled and is released",
    async (held, sent) => {
      const step = heldStep(held);
      const sessions = new SparkSessions(step.deps, PLACE);
      const setup = sessions.metadata().then(
        () => undefined,
        (error: unknown) => error,
      );
      await step.reached;
      const released = sessions.releaseAll();
      step.open();
      await released;
      expect(refusalOf(await setup)).toStrictEqual(cancelled);
      const session = fake.log.entries[0]?.sessionId;
      expect(received()).toStrictEqual(sent.map((name) => [session, name]));
      expect(sessions.openCount()).toBe(0);
    },
  );

  test("a metadata read whose session's setup answers once releaseAll began is refused as cancelled, and nothing is sent for it", async () => {
    const step = heldStep("Config set");
    const sessions = new SparkSessions(step.deps, {});
    const seen: string[] = [];
    const read = sessions.readMetadata(configRead(seen)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await step.reached;
    const released = sessions.releaseAll();
    step.open();
    await released;
    expect(refusalOf(await read)).toStrictEqual(cancelled);
    expect(seen).toStrictEqual([]);
    const session = fake.log.entries[0]?.sessionId;
    expect(received()).toStrictEqual([
      [session, "Config set"],
      [session, "ReleaseSession"],
    ]);
    expect(sessions.openCount()).toBe(0);
  });

  test("a metadata read whose repeat's setup answers once releaseAll began is refused as cancelled after its one read of the closed session", async () => {
    const step = heldStep("Config set", 1);
    const sessions = new SparkSessions(step.deps, {});
    const first = await sessions.metadata();
    await channel.unary("ReleaseSession", releaseSessionRequest(first), call());
    fake.log.clear();
    const seen: string[] = [];
    const read = sessions.readMetadata(configRead(seen)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await step.reached;
    const released = sessions.releaseAll();
    step.open();
    await released;
    expect(refusalOf(await read)).toStrictEqual(cancelled);
    expect(seen).toStrictEqual([first.sessionId]);
    const fresh = fake.log.entries[1]?.sessionId;
    expect(fresh).not.toBe(first.sessionId);
    expect(received()).toStrictEqual([
      [first.sessionId, "Config read"],
      [fresh, "Config set"],
      [fresh, "ReleaseSession"],
    ]);
    expect(sessions.openCount()).toBe(0);
  });

  test.each<[string, SparkSessionPlace, readonly string[]]>([
    ["a catalog and a namespace", PLACE, ["Config set", "ReleaseSession"]],
    ["no catalog or namespace", {}, ["Config set"]],
  ])(
    "close, with %s, sends nothing itself, refuses the next step of a setup in flight and every read from then on, and leaves the releases to releaseAll",
    async (_label, place, closed) => {
      const step = heldStep("Config set");
      const sessions = new SparkSessions(step.deps, place);
      const seen: string[] = [];
      const read = () =>
        sessions.readMetadata(configRead(seen)).then(
          () => undefined,
          (error: unknown) => error,
        );
      const waiting = read();
      await step.reached;
      sessions.close();
      step.open();
      expect(refusalOf(await waiting)).toStrictEqual(cancelled);
      const session = fake.log.entries[0]?.sessionId;
      expect(received()).toStrictEqual(closed.map((name) => [session, name]));
      // A read or a scope asked for once the registry closed is refused before anything is sent, a set-up session too.
      expect(refusalOf(await read())).toStrictEqual(cancelled);
      expect(
        refusalOf(
          await sessions.forScope("late").then(
            () => undefined,
            (error: unknown) => error,
          ),
        ),
      ).toStrictEqual(cancelled);
      expect(seen).toStrictEqual([]);
      expect(received()).toStrictEqual(closed.map((name) => [session, name]));
      await sessions.releaseAll();
      expect(received()).toStrictEqual([
        [session, "Config set"],
        [session, "ReleaseSession"],
      ]);
      expect(sessions.openCount()).toBe(0);
    },
  );
});

describe("the metadata session after the server closed it", () => {
  test("the read that met the closed session is repeated once on a new one", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    await channel.unary("ReleaseSession", releaseSessionRequest(first), call());
    const seen: string[] = [];
    const value = await sessions.readMetadata(configRead(seen));
    expect(value).toBe(42);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(first.sessionId);
    expect(seen[1]).not.toBe(first.sessionId);
    await sessions.releaseAll();
  });

  test("a restarted server's SESSION_CHANGED on the metadata session is read again on a new one", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    fake.restart();
    const seen: string[] = [];
    expect(await sessions.readMetadata(configRead(seen))).toBe(42);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(first.sessionId);
    expect(seen[1]).not.toBe(first.sessionId);
    await sessions.releaseAll();
  });

  test("the repeat reads only a SparkError: the version read after a restart, unmapped and then mapped", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    fake.restart();
    const seen: string[] = [];
    const version = (session: SparkSessionRef) => {
      seen.push(session.sessionId);
      return channel.unary("AnalyzePlan", versionRequest(session), call());
    };
    // Unmapped, the restarted server's refusal is the channel's own error: never repeated, the closed session kept.
    const unmapped = await sessions.readMetadata(version).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(unmapped).toBeInstanceOf(Error);
    expect(unmapped).not.toBeInstanceOf(SparkError);
    expect(sparkErrorOf(unmapped).category).toBe("session-changed");
    expect(seen).toStrictEqual([first.sessionId]);
    expect(await sessions.metadata()).toBe(first);
    // Mapped inside the read, as the provider's reads are, the same refusal is repeated once on a new session.
    const answer = await sessions.readMetadata(async (session) => {
      try {
        return await version(session);
      } catch (error) {
        throw sparkErrorOf(error);
      }
    });
    expect((answer as { spark_version?: { version?: string } }).spark_version?.version).toBe("4.2.0");
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(first.sessionId);
    expect(seen[2]).not.toBe(first.sessionId);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  test("SESSION_NOT_FOUND on the metadata session is read again on a new one", async () => {
    statements["SHOW NAMESPACES"] = {
      kind: "error",
      code: 13,
      message: "[INVALID_HANDLE.SESSION_NOT_FOUND] The handle is invalid. Session not found.",
      errorInfo: { errorClass: "INVALID_HANDLE.SESSION_NOT_FOUND", sqlState: "HY000" },
    };
    const sessions = new SparkSessions(deps(), {});
    const seen: string[] = [];
    const value = await sessions.readMetadata(async (session) => {
      seen.push(session.sessionId);
      try {
        await runStatement(session, "SHOW NAMESPACES");
      } catch (error) {
        // The fake answers by statement text, so the new session's read is answered as a live session's.
        statements["SHOW NAMESPACES"] = OK;
        throw sparkErrorOf(error);
      }
      return "read";
    });
    expect(value).toBe("read");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    await sessions.releaseAll();
  });

  test("two reads that meet the closed session together discard it once and repeat on one new session", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    const read = async (session: SparkSessionRef) => {
      if (session.sessionId === first.sessionId) throw new SparkError("session-closed", "closed");
      return session.sessionId;
    };
    const [a, b] = await Promise.all([sessions.readMetadata(read), sessions.readMetadata(read)]);
    expect(a).not.toBe(first.sessionId);
    expect(b).toBe(a);
    expect(fake.log.entries.filter((entry) => entry.rpc === "Config")).toHaveLength(2);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });

  test("a repeat that meets a closed session too fails with the metadata sentence; another error is never repeated", async () => {
    const sessions = new SparkSessions(deps(), {});
    let calls = 0;
    const closed = await sessions
      .readMetadata(async () => {
        calls += 1;
        throw new SparkError("session-closed", `closed ${calls}`);
      })
      .then(
        () => undefined,
        (error: unknown) => error as SparkError,
      );
    expect(calls).toBe(2);
    expect(closed?.message).toBe(SPARK_ERROR_SENTENCES.metadataSessionLost);
    expect((closed?.cause as SparkError | undefined)?.message).toBe("closed 2");
    let other = 0;
    const plain = await sessions
      .readMetadata(async () => {
        other += 1;
        throw new SparkError("spark", "a Spark error");
      })
      .then(
        () => undefined,
        (error: unknown) => error as SparkError,
      );
    expect(other).toBe(1);
    expect(plain?.message).toBe("a Spark error");
    let local = 0;
    const thrown = new Error("not a SparkError");
    const notSpark = await sessions
      .readMetadata(async () => {
        local += 1;
        throw thrown;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(local).toBe(1);
    expect(notSpark).toBe(thrown);
    let changed = 0;
    const repeated = await sessions.readMetadata(async () => {
      changed += 1;
      if (changed === 1) throw new SparkError("session-changed", "restarted");
      return "fresh";
    });
    expect(repeated).toBe("fresh");
    const second = await sessions
      .readMetadata(async () => {
        throw new SparkError("session-closed", "first");
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(second).toBeInstanceOf(SparkError);
    expect(second).toMatchObject({ category: "session-closed", message: SPARK_ERROR_SENTENCES.metadataSessionLost });
    const failing = await sessions
      .readMetadata(async () => {
        throw new SparkError("session-closed", "x");
      })
      .then(
        () => "no",
        (error: unknown) => (error as SparkError).category,
      );
    expect(failing).toBe("session-closed");
    // A repeat that fails another way fails with that error, unchanged.
    let attempts = 0;
    const unreachable = new SparkError("not-connected", "unreachable");
    const network = await sessions
      .readMetadata(async () => {
        attempts += 1;
        if (attempts === 1) throw new SparkError("session-closed", "closed");
        throw unreachable;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(attempts).toBe(2);
    expect(network).toBe(unreachable);
    await sessions.releaseAll();
  });

  test("a read waits for each setup through the wait it is given, its first and its repeat's, and reads no session the wait refuses", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    const waited: string[] = [];
    const wait = async (setup: Promise<SparkSessionHandle>) => {
      const handle = await setup;
      waited.push(handle.sessionId);
      return handle;
    };
    const seen: string[] = [];
    const read = async (session: SparkSessionRef) => {
      seen.push(session.sessionId);
      if (session.sessionId === first.sessionId) throw new SparkError("session-closed", "closed");
      return session.sessionId;
    };
    const fresh = await sessions.readMetadata(read, wait);
    expect(seen).toStrictEqual([first.sessionId, fresh]);
    expect(waited).toStrictEqual([first.sessionId, fresh]);
    // A wait that refuses the first setup fails the read with its refusal, before the read is given a session.
    const refusal = new SparkError("deadline", "past the deadline");
    const refused = await sessions.readMetadata(read, () => Promise.reject(refusal)).catch((error: unknown) => error);
    expect(refused).toBe(refusal);
    expect(seen).toStrictEqual([first.sessionId, fresh]);
    // One that refuses the repeat's setup fails the read with its refusal too, after the one read of the closed session.
    let waits = 0;
    const closedAgain = async (session: SparkSessionRef) => {
      seen.push(session.sessionId);
      throw new SparkError("session-closed", "closed");
    };
    const repeat = await sessions
      .readMetadata(closedAgain, (setup) => {
        waits += 1;
        return waits === 1 ? setup : Promise.reject(refusal);
      })
      .catch((error: unknown) => error);
    expect(repeat).toBe(refusal);
    expect(waits).toBe(2);
    expect(seen).toStrictEqual([first.sessionId, fresh, fresh]);
    await sessions.releaseAll();
  });

  test("the wait and the read are each told whether they serve the repeat, which follows a read of the closed session", async () => {
    const sessions = new SparkSessions(deps(), {});
    const first = await sessions.metadata();
    const told: [string, string, boolean][] = [];
    const value = await sessions.readMetadata(
      async (session, repeat) => {
        told.push(["read", session === first ? "first" : "fresh", repeat]);
        if (session === first) throw new SparkError("session-closed", "closed");
        return "fresh";
      },
      async (setup, repeat) => {
        const session = await setup;
        told.push(["wait", session === first ? "first" : "fresh", repeat]);
        return session;
      },
    );
    expect(value).toBe("fresh");
    expect(told).toStrictEqual([
      ["wait", "first", false],
      ["read", "first", false],
      ["wait", "fresh", true],
      ["read", "fresh", true],
    ]);
    await sessions.releaseAll();
  });

  test("a metadata session discarded while its setup is in flight is released once the setup settles", async () => {
    const hold = Promise.withResolvers<void>();
    const releasing: Promise<void>[] = [];
    const sessions = new SparkSessions(
      deps({
        configSet: async (session, pairs) => {
          await hold.promise;
          return deps().configSet(session, pairs);
        },
        release: (session) => {
          const done = deps().release(session);
          releasing.push(done);
          return done;
        },
      }),
      {},
    );
    // With no metadata session, a discard is nothing.
    sessions.discardMetadata();
    const pending = sessions.metadata();
    sessions.discardMetadata();
    hold.resolve();
    const handle = await pending;
    await Promise.all(releasing);
    expect(releasesOf().map((entry) => entry.sessionId)).toStrictEqual([handle.sessionId]);
    expect(sessions.openCount()).toBe(0);
    expect((await sessions.metadata()).sessionId).not.toBe(handle.sessionId);
    expect(sessions.openCount()).toBe(1);
    await sessions.releaseAll();
  });
});
