/**
 * Retries, budgets and the final of a complete result (design 3.11, 3.12; C7, C10; X02, X15, X16): a statement POST
 * the warehouse may have received is never resent, a gateway `ProvisionWarehouseTimeout` is resent with the same ids,
 * a GET is retried on the network and an intermediary's status, the page attempt timer requests the same page once,
 * the statement deadline is never retried, a failed final of a complete result is a notice, and the row, cell and
 * byte budgets cut the result and close it with a final.
 */
import { describe, expect, test } from "bun:test";
import { decodeOutcome } from "@/lib/db/providers/sql/databend/decode";
import { DATABEND_ERROR_SENTENCES as S } from "@/lib/db/providers/sql/databend/errors";
import { DATABEND_PAGE_UNANSWERED } from "@/lib/db/providers/sql/databend/http-transport";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import {
  idsOf,
  ok,
  pathsOf,
  runSignal,
  type ScriptedStep,
  statement,
  testOptions,
  transportHarness,
} from "../../../helpers/databend-node-transport";

const FIRST = idsOf(1);
const P = pathsOf(FIRST.queryId);
const LOGOUT = "/v1/session/logout";
const INSERTED = {
  schema: [{ name: "number of rows inserted", type: "UInt64" }],
  data: [["3"]],
  next_uri: P.final,
};

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

describe("the final of a complete result (X02)", () => {
  test("a completed INSERT whose final answers 500 returns its rowCount and a notice", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, INSERTED) },
      { method: "GET", path: P.final, reply: { status: 500, body: "panic", contentType: "text/plain" } },
    ]);
    const outcome = await transport.run(statement("INSERT INTO t VALUES (1), (2), (3)"));
    script.expectDone();
    expect(decodeOutcome(outcome, "INSERT").rowCount).toBe(3);
    expect(outcome.notices).toEqual([{ kind: "close-refused", step: "final" }]);
  });

  test("a final that fails on the network three times is retried after 1 and 2 s, then a notice", async () => {
    // No answer at all: one cut short once it began was answered, a refused close (http-transport-session.test.ts).
    const lost: ScriptedStep = { method: "GET", path: P.final, reply: { fail: "network" } };
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, INSERTED) },
      lost,
      lost,
      lost,
    ]);
    const outcome = await transport.run(statement("INSERT INTO t VALUES (1), (2), (3)"));
    script.expectDone();
    expect(decodeOutcome(outcome, "INSERT").rowCount).toBe(3);
    expect(outcome.notices).toEqual([{ kind: "close-failed", step: "final" }]);
    expect(time.sleeps).toEqual([1000, 2000]);
  });
});

describe("the statement POST (C10)", () => {
  test("a ProvisionWarehouseTimeout is resent with the same ids and body after the backoff", async () => {
    const { script, time, transport } = transportHarness(
      [
        {
          method: "POST",
          path: "/v1/query",
          reply: { status: 200, body: { kind: "ProvisionWarehouseTimeout", message: "resuming" } },
        },
        { method: "POST", path: "/v1/query", reply: ok(FIRST) },
      ],
      { random: 0 },
    );
    await transport.run(statement("SELECT 1"));
    script.expectDone();
    const [one, two] = script.requests;
    expect(two.headers).toEqual(one.headers);
    expect(two.body).toBe(one.body);
    // 1 s less the 20 percent jitter at random 0.
    expect(time.sleeps).toEqual([800]);
  });

  test.each([
    ["a 503", 503],
    ["a 200", 200],
  ])(
    "a ProvisionWarehouseTimeout nested under error, as Databend Cloud nests its kinds, over %s is resent (I19)",
    async (_label, status) => {
      const { script, time, transport } = transportHarness(
        [
          {
            method: "POST",
            path: "/v1/query",
            reply: { status, body: { error: { kind: "ProvisionWarehouseTimeout", message: "resuming" } } },
          },
          { method: "POST", path: "/v1/query", reply: ok(FIRST) },
        ],
        { random: 0 },
      );
      await transport.run(statement("SELECT 1"));
      script.expectDone();
      const [one, two] = script.requests;
      expect(two.headers).toEqual(one.headers);
      expect(two.body).toBe(one.body);
      expect(time.sleeps).toEqual([800]);
    },
  );

  describe("a stop during the backoff after a ProvisionWarehouseTimeout, which the gateway answers unforwarded (HASIM-D-4)", () => {
    const resuming: ScriptedStep = {
      method: "POST",
      path: "/v1/query",
      reply: { status: 503, body: { error: { kind: "ProvisionWarehouseTimeout", message: "provision timeout" } } },
    };

    test.each([
      ["a cancel", "cancel", "user", "cancelled", S.cancelled],
      ["the statement deadline", "expire", "user", "timeout", S.deadline("60")],
      // Studio's own read on a named warehouse: the resuming outcome, which a route shows as it is (GAP-CL-1).
      ["a provider statement's deadline", "expire", "provider", "unavailable", S.resuming("default", "10")],
    ] as const)(
      "%s sends no kill and no logout, and says the statement was not sent",
      async (_label, how, origin, category, message) => {
        const run = runSignal();
        const { script, time, transport } = transportHarness([resuming, resuming], {
          options: testOptions({ warehouse: "default" }),
        });
        // The stop fires in the second backoff, after two attempts the gateway answered.
        time.onSleep(() => {
          if (time.sleeps.length === 1) run[how]();
        });
        const error = await failure(
          transport.run(statement("INSERT INTO t VALUES (1)", { origin, signal: run.signal })),
        );
        expect(error.category).toBe(category);
        expect(error.message).toBe(message);
        expect(script.requests).toHaveLength(2);
        script.expectDone();
      },
    );

    test("a cancel while a resent POST is in flight may have reached Databend: it is killed and logged out", async () => {
      const { script, time, transport } = transportHarness(
        [
          resuming,
          { method: "POST", path: "/v1/query", reply: { hang: true } },
          { method: "GET", path: P.kill, reply: { status: 200 } },
          { method: "POST", path: LOGOUT, reply: { status: 200 } },
        ],
        { options: testOptions({ warehouse: "default" }) },
      );
      const run = runSignal();
      const running = failure(transport.run(statement("INSERT INTO t VALUES (1)", { signal: run.signal })));
      await script.received(2);
      run.cancel();
      expect((await running).category).toBe("cancelled");
      expect(time.sleeps).toEqual([1000]);
      script.expectDone();
    });
  });

  test("a ProvisionWarehouseTimeout past the deadline is unavailable, with nothing more sent", async () => {
    const warehouse = testOptions({ warehouse: "wh" }, { queryTimeout: 1000 });
    const { script, transport } = transportHarness(
      [
        {
          method: "POST",
          path: "/v1/query",
          reply: { status: 504, body: { kind: "ProvisionWarehouseTimeout", message: "resuming" } },
        },
      ],
      { options: warehouse },
    );
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("unavailable");
    expect(error.message).toBe(S.resuming("wh", "1"));
  });

  test.each([
    ["503", { status: 503 }],
    ["429", { status: 429, retryAfter: "1" }],
    ["502", { status: 502 }],
  ])(
    "a %s without a gateway kind is one POST, outcome-unknown, then the kill and the logout",
    async (_label, reply) => {
      const { script, transport } = transportHarness([
        { method: "POST", path: "/v1/query", reply },
        { method: "GET", path: P.kill, reply: { status: 404 } },
        { method: "GET", path: P.kill, reply: { status: 200 } },
        { method: "POST", path: LOGOUT, reply: { status: 200 } },
      ]);
      const error = await failure(transport.run(statement("INSERT INTO t VALUES (1)")));
      script.expectDone();
      expect(error.category).toBe("outcome-unknown");
    },
  );

  test("a provider POST answered 502 is network, and is closed the same way", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 502 } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1", { origin: "provider" })))).category).toBe("network");
    script.expectDone();
  });

  test("a TLS failure on the POST is tls, and nothing more is sent: it never reached the handler", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: { fail: "tls" } }]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("tls");
    script.expectDone();
  });

  test("another 5xx on the POST is server, and the statement it may have registered is killed", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 500, body: "panic", contentType: "text/plain" } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("server");
    script.expectDone();
  });
});

describe("a page GET", () => {
  test("is retried on 503 after the backoff, a Retry-After honoured", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { status: 503, retryAfter: "3" } },
      { method: "GET", path: P.page(0), reply: { fail: "network" } },
      { method: "GET", path: P.page(0), reply: ok(FIRST) },
    ]);
    await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(time.sleeps).toEqual([3000, 2000]);
  });

  test("a 503 three times is unavailable, and the statement is killed", async () => {
    const busy: ScriptedStep = { method: "GET", path: P.page(0), reply: { status: 503 } };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      busy,
      busy,
      busy,
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("unavailable");
    script.expectDone();
  });

  test("its attempt timer expiring requests the same page once, at once, under min(deadline, 25 s) [X15, X16]", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.page(0), reply: ok(FIRST) },
    ]);
    const running = transport.run(statement("SELECT 1"));
    await script.received(2);
    time.fire(25_000);
    await running;
    script.expectDone();
    expect(time.sleeps).toEqual([]);
    expect(time.deadlines.map((deadline) => deadline.ms)).toEqual([25_000, 25_000]);
  });

  test("a second expiry is not retried: the statement is killed and timeout", async () => {
    const { script, time, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
        { method: "GET", path: P.page(0), reply: { hang: true } },
        { method: "GET", path: P.page(0), reply: { hang: true } },
        { method: "GET", path: P.kill, reply: { status: 200 } },
      ],
      { options: testOptions({}, { queryTimeout: 20_000 }) },
    );
    const running = failure(transport.run(statement("SELECT 1")));
    await script.received(2);
    // A 20 s deadline: the attempt timer is the time left, and the second expiry is the deadline itself.
    time.fire(20_000);
    await script.received(3);
    time.advance(20_000);
    time.fire(20_000);
    expect((await running).category).toBe("timeout");
    script.expectDone();
  });

  test("two expiries with deadline left are a page that gave no answer, never the statement deadline", async () => {
    const { script, time, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
        { method: "GET", path: P.page(0), reply: { hang: true } },
        { method: "GET", path: P.page(0), reply: { hang: true } },
        { method: "GET", path: P.kill, reply: { status: 200 } },
      ],
      { options: testOptions({}, { queryTimeout: 300_000 }) },
    );
    const running = failure(transport.run(statement("SELECT 1")));
    await script.received(2);
    time.advance(25_000);
    time.fire(25_000);
    await script.received(3);
    time.advance(25_000);
    time.fire(25_000);
    const error = await running;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    expect(error.message).toBe(S.noAnswer(DATABEND_PAGE_UNANSWERED));
  });

  test("the statement deadline is never retried", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.expire();
    expect((await running).category).toBe("timeout");
    script.expectDone();
  });

  test("an answer over the cap is too-large, and the statement is killed", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { fail: "too-large" } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("too-large");
    script.expectDone();
  });

  test("a refusal of the node transport on a page is config, and the statement is killed", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { throws: new Error("Invalid request headers") } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("config");
    script.expectDone();
  });
});

describe("the statement budget (design 3.12)", () => {
  const schema = [
    { name: "a", type: "Int32" },
    { name: "b", type: "Int32" },
  ];

  test("past the row cut the result is truncated at the cut and closed with a final", async () => {
    const rows = Array.from({ length: 11 }, (_, n) => [String(n), String(n)]);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { schema, data: rows, next_uri: P.page(1) }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    const outcome = await transport.run(statement("SELECT a, b FROM t", { rowCut: 10 }));
    script.expectDone();
    expect(outcome.truncated).toEqual({ bound: "rows", limit: 10 });
    expect(outcome.rows).toHaveLength(10);
  });

  test("exactly the row cut is not truncated", async () => {
    const rows = Array.from({ length: 10 }, (_, n) => [String(n), String(n)]);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { schema, data: rows }) },
    ]);
    expect((await transport.run(statement("SELECT a, b FROM t", { rowCut: 10 }))).truncated).toBeNull();
    script.expectDone();
  });

  test("past 250,000 cells the result is cut at the whole rows that fit", async () => {
    const wide = Array.from({ length: 100 }, (_, n) => ({ name: `c${n}`, type: "Int32" }));
    const row = Array.from({ length: 100 }, () => "1");
    const page = (count: number) => Array.from({ length: count }, () => row);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { schema: wide, data: page(2000), next_uri: P.page(1) }) },
      { method: "GET", path: P.page(1), reply: ok(FIRST, { schema: wide, data: page(2000), next_uri: P.final }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    const outcome = await transport.run(statement("SELECT * FROM wide", { rowCut: 100_000 }));
    script.expectDone();
    expect(outcome.truncated).toEqual({ bound: "cells", limit: 250_000 });
    expect(outcome.rows).toHaveLength(2500);
  });

  test("past the statement's bytes the page that crosses them is dropped, and a final closes it", async () => {
    const options = { ...testOptions(), statementBytes: 2000 };
    const filler = [["x".repeat(900)]];
    const text = [{ name: "t", type: "String" }];
    const { script, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { schema: text, data: filler, next_uri: P.page(1) }) },
        { method: "GET", path: P.page(1), reply: ok(FIRST, { schema: text, data: filler, next_uri: P.page(2) }) },
        { method: "GET", path: P.final, reply: ok(FIRST) },
      ],
      { options },
    );
    const outcome = await transport.run(statement("SELECT t FROM big", { rowCut: 100 }));
    script.expectDone();
    expect(outcome.truncated).toEqual({ bound: "bytes", limit: 2000 });
    expect(outcome.rows).toHaveLength(1);
  });

  test("a cut on the answer that ends the statement sends nothing more", async () => {
    const rows = Array.from({ length: 3 }, (_, n) => [String(n), String(n)]);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { schema, data: rows }) },
    ]);
    expect((await transport.run(statement("SELECT a, b FROM t", { rowCut: 2 }))).truncated).toEqual({
      bound: "rows",
      limit: 2,
    });
    script.expectDone();
  });
});
