/**
 * Cancel, deadline, kill and close (design 3.10; C9; X02, X16, X31): one kill per stop, a hanging kill cut by its own
 * 5 s, a kill answered 404 before the first answer sent again at 250, 500 and 1000 ms, and after a Running answer a
 * cancel that is `cancelled`, and a user statement's deadline that is `timeout`, only on a kill 200 or a 1043 answer,
 * while Studio's own read is `timeout` at its deadline whatever the kill answered. Every timer is the injected
 * `deadline`.
 */
import { describe, expect, test } from "bun:test";
import { DATABEND_ERROR_SENTENCES as S } from "@/lib/db/providers/sql/databend/errors";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import {
  idsOf,
  ok,
  pathsOf,
  runSignal,
  statement,
  TEST_NODE,
  transportHarness,
  transportDeps,
  scriptedNodeTransport,
} from "../../../helpers/databend-node-transport";
import path from "node:path";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { DATABEND_CLOSE_TIMEOUT_MS, DATABEND_DEFAULT_PORT } from "@/lib/db/providers/sql/databend/connection-options";
import { DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import { LOGOUT_PATH, QUERY_PATH } from "@/lib/db/providers/sql/databend/routes";
import { type DatabaseConnection } from "@/lib/types";
import { readFileSync } from "node:fs";

const FIRST = idsOf(1);
const P = pathsOf(FIRST.queryId);
const LOGOUT = "/v1/session/logout";
const RUNNING = ok(FIRST, { state: "Running", next_uri: P.page(0) });

async function failure(promise: Promise<unknown>): Promise<DatabendError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DatabendError);
  return error as DatabendError;
}

describe("after a Running answer (X02)", () => {
  test("a cancel sends one kill, with the sticky node, and a kill 200 is cancelled", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 200, body: "", contentType: null } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.cancel();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("cancelled");
    expect(error.message).toBe(S.cancelled);
    expect(script.requests[2].headers["x-databend-sticky-node"]).toBe(TEST_NODE);
  });

  test("a failed kill is outcome-unknown", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 500, body: "panic", contentType: "text/plain" } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.cancel();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.cancelUnanswered);
  });

  test("a hanging kill is cut by its own 5 s deadline, and the cancel is outcome-unknown [X16]", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { hang: true } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.cancel();
    await script.received(3);
    time.fire(5000);
    expect((await running).category).toBe("outcome-unknown");
    script.expectDone();
  });

  test("a kill a gateway answers 200 with ProvisionWarehouseTimeout is retried, and is never an acknowledged cancel", async () => {
    const resuming = { status: 200, body: { error: { kind: "ProvisionWarehouseTimeout", message: "resuming" } } };
    const kill = { method: "GET" as const, path: P.kill, reply: resuming };
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      kill,
      kill,
      kill,
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.cancel();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.cancelUnanswered);
    // The GET backoff inside the kill's own 5 s: three attempts.
    expect(time.sleeps).toEqual([1000, 2000]);
  });

  test("a 1043 answer under our cancel is cancelled, and the final link closes it", async () => {
    const run = runSignal();
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      {
        method: "GET",
        path: P.page(0),
        reply: () => {
          run.cancel();
          return ok(FIRST, {
            state: "Failed",
            error: { code: 1043, message: "canceled by client" },
            next_uri: P.final,
          });
        },
      },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    const error = await failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    script.expectDone();
    expect(error.category).toBe("cancelled");
  });

  test("the statement deadline with a kill Databend did not acknowledge is outcome-unknown: it may still finish", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { fail: "network" } },
      { method: "GET", path: P.kill, reply: { fail: "network" } },
      { method: "GET", path: P.kill, reply: { fail: "network" } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("INSERT INTO t VALUES (1)", { signal: run.signal })));
    await script.received(2);
    run.expire();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.deadlineUnacknowledged("60"));
  });

  test("the statement deadline with a kill a gateway refuses over HTTP 200 is outcome-unknown too", async () => {
    const resuming = { status: 200, body: { error: { kind: "ProvisionWarehouseTimeout", message: "resuming" } } };
    const kill = { method: "GET" as const, path: P.kill, reply: resuming };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      kill,
      kill,
      kill,
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("INSERT INTO t VALUES (1)", { signal: run.signal })));
    await script.received(2);
    run.expire();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.deadlineUnacknowledged("60"));
  });

  test("the statement deadline with a kill 200 is timeout: Studio cancelled it", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 200, body: "", contentType: null } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("INSERT INTO t VALUES (1)", { signal: run.signal })));
    await script.received(2);
    run.expire();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("timeout");
    expect(error.message).toBe(S.deadline("60"));
  });

  test("a stop between two pages sends no further page, only the kill", async () => {
    const run = runSignal();
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: () => {
          run.cancel();
          return RUNNING;
        },
      },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1", { signal: run.signal })))).category).toBe("cancelled");
    script.expectDone();
  });
});

describe("before the first answer (design 3.10)", () => {
  test("a kill answered 404, 404, then 200 is cancelled, resent at 250 and 500 ms, then one logout", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 404 } },
      { method: "GET", path: P.kill, reply: { status: 404 } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.cancel();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("cancelled");
    expect(time.sleeps).toEqual([250, 500]);
    expect(script.requests[1].headers["x-databend-sticky-node"]).toBeUndefined();
  });

  test("four kills answered 404 are outcome-unknown", async () => {
    const kill = { method: "GET" as const, path: P.kill, reply: { status: 404 } };
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      kill,
      kill,
      kill,
      kill,
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.cancel();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.noAnswer(S.cancelledBeforeAnswer));
    expect(time.sleeps).toEqual([250, 500, 1000]);
  });

  test("the resends stop when the kill's own 5 s runs out", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 404 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    // The kill's budget is the first 5 s deadline asked for; it fires while the first resend waits.
    time.onSleep(() => time.fire(5000));
    run.cancel();
    expect((await running).category).toBe("outcome-unknown");
    script.expectDone();
  });

  test("the statement deadline with an acknowledged kill is timeout", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.expire();
    expect((await running).category).toBe("timeout");
    script.expectDone();
  });
});

describe("the statement deadline by origin, with a kill Databend did not acknowledge (Z5)", () => {
  test.each([
    ["a user statement", "before", "outcome-unknown", "user", S.noAnswer(S.deadlineBeforeAnswer("60"))],
    ["a user statement", "after", "outcome-unknown", "user", S.deadlineUnacknowledged("60")],
    ["Studio's own read", "before", "timeout", "provider", S.deadline("10")],
    ["Studio's own read", "after", "timeout", "provider", S.deadline("10")],
  ] as const)("%s %s its first answer is %s", async (_label, when, category, origin, message) => {
    const before = when === "before";
    const refused = { status: 500, body: "panic", contentType: "text/plain" };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: before ? { hang: true } : RUNNING },
      ...(before
        ? [
            { method: "GET" as const, path: P.kill, reply: refused },
            { method: "POST" as const, path: LOGOUT, reply: { status: 200 } },
          ]
        : [
            { method: "GET" as const, path: P.page(0), reply: { hang: true as const } },
            { method: "GET" as const, path: P.kill, reply: refused },
          ]),
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { origin, signal: run.signal })));
    await script.received(before ? 1 : 2);
    run.expire();
    const error = await running;
    script.expectDone();
    expect(error.category).toBe(category);
    expect(error.message).toBe(message);
  });
});

describe("close() (X31)", () => {
  test("cancels each open run, each with its own kill, then releases the sockets once", async () => {
    const second = idsOf(2);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: { hang: true } },
    ]);
    const one = failure(transport.run(statement("SELECT 1")));
    await script.received(2);
    script.push(
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(second, { state: "Running", next_uri: pathsOf(second.queryId).page(0) }),
      },
      { method: "GET", path: pathsOf(second.queryId).page(0), reply: { hang: true } },
    );
    const two = failure(transport.run(statement("SELECT 2")));
    await script.received(4);
    script.push(
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "GET", path: pathsOf(second.queryId).kill, reply: { status: 200 } },
    );
    await transport.close();
    expect(script.closes()).toBe(1);
    expect((await one).category).toBe("cancelled");
    expect((await two).category).toBe("cancelled");
    script.expectDone();
  });

  test("a run after close() is cancelled with nothing sent", async () => {
    const { script, transport } = transportHarness([]);
    await transport.close();
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("cancelled");
    expect(script.requests).toHaveLength(0);
  });
});

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const CONNECTION: DatabaseConnection = {
  id: "databend-doc",
  name: "Databend",
  type: "databend",
  host: "localhost",
  port: DATABEND_DEFAULT_PORT,
  user: "root",
  createdAt: new Date(0),
};
/** Thousands grouped by commas, the same in every locale. */
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

describe("the kill resends, a refused kill and Stop's wait", () => {
  test("a kill that keeps answering 404 is sent four times, three waits apart", async () => {
    const ids = idsOf(1);
    const kill = { method: "GET" as const, path: pathsOf(ids.queryId).kill, reply: { status: 404 } };
    const { script, time, transport } = transportHarness([
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      kill,
      kill,
      kill,
      kill,
      { method: "POST", path: LOGOUT_PATH, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = transport.run(statement("SELECT 1", { signal: run.signal })).catch((error: unknown) => error);
    await script.received(1);
    run.cancel();
    expect(await running).toBeInstanceOf(DatabendError);
    script.expectDone();
    const waits = time.sleeps.map(n);
    expect(waits).toHaveLength(3);
  });

  test("a kill a gateway refuses over HTTP 200 is no acknowledged cancel (REV-T-2)", async () => {
    const ids = idsOf(1);
    const refused = { status: 200, body: { error: { kind: "AuthorizationFailed", message: "Authorization failed" } } };
    const { script, transport } = transportHarness([
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      { method: "GET", path: pathsOf(ids.queryId).kill, reply: refused },
    ]);
    const run = runSignal();
    const running = transport.run(statement("SELECT 1", { signal: run.signal })).catch((error: unknown) => error);
    await script.received(1);
    run.cancel();
    expect(((await running) as DatabendError).category).toBe("outcome-unknown");
    script.expectDone();
  });

  test("Stop reports a cancel only for a run that ended cancelled, waiting at most three close timeouts (GAP-SH-C8-1)", async () => {
    // The editor's titles for the cancel route's two answers.
    const editor = read("src/hooks/use-query-execution.ts");
    for (const title of ["Query Cancelled", "Cancel Not Confirmed"]) {
      expect(editor).toContain(`title: "${title}"`);
    }
    // A run stopped before its first answer whose kill never answers: the cancel asks for one deadline, its wait.
    const script = scriptedNodeTransport([
      {
        method: "POST",
        path: QUERY_PATH,
        reply: ok(idsOf(1), { schema: [{ name: "server_version", type: "String" }] }),
      },
      { method: "POST", path: QUERY_PATH, reply: ok(idsOf(2), { schema: [{ name: "auth_type", type: "String" }] }) },
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      { method: "GET", path: pathsOf(idsOf(3).queryId).kill, reply: { hang: true } },
      { method: "POST", path: LOGOUT_PATH, reply: { status: 200 } },
    ]);
    const time = transportDeps(script);
    const subject = new DatabendProvider(CONNECTION, {}, { egress: ALLOWS_PRIVATE_HOSTS }, time.deps);
    await subject.connect();
    const running = subject.query("SELECT 1", undefined, "doc-cancel").catch((error: unknown) => error);
    await script.received(3);
    const asked = time.deadlines.length;
    const cancelling = subject.cancelQuery("doc-cancel");
    const wait = time.deadlines[asked].ms;
    await script.received(4);
    expect(wait).toBe(3 * DATABEND_CLOSE_TIMEOUT_MS);
    time.fire(wait);
    expect(await cancelling).toBe(false);
    time.fire(DATABEND_CLOSE_TIMEOUT_MS);
    expect(await running).toBeInstanceOf(Error);
    await subject.disconnect();
    script.expectDone();
  });
});
