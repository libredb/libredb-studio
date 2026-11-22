/**
 * The sign-in latch as the transport uses it (design 3.5; C5; X03, X14, I10, I18): a refused password is sent once,
 * then two instances on one key send nothing for 15 minutes; 2215 over HTTP 500 latches, an in-body 2215 does not;
 * a refusal of a close latches like one of the POST, and the run sends nothing after it; a gateway refusal over HTTP
 * 200 latches and only an answer proves a key; two tunnels to one far end share a key; two concurrent runs on an
 * unproven key send one request, the second only after the first's closes; a latch wait cut short by the run's own
 * signal is its stop, with nothing sent; a 401 with no sign-in code latches nothing and is worded by the request it
 * refused, the POST or a follow-up.
 */
import { describe, expect, test } from "bun:test";
import { AUTH_LATCH_TTL_MS, createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import { DATABEND_ERROR_SENTENCES as S } from "@/lib/db/providers/sql/databend/errors";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import {
  idsOf,
  ok,
  pathsOf,
  runSignal,
  scriptedNodeTransport,
  statement,
  TEST_START,
  testOptions,
  testQueryId,
  transportDeps,
  transportHarness,
} from "../../../helpers/databend-node-transport";

const FIRST = idsOf(1);
const LOGOUT = "/v1/session/logout";
/** A session the statement left with a transaction open and a temporary table, which the end-open would close. */
const OPEN = { txn_state: "Active", need_keep_alive: true, settings: { http_json_result_mode: "display" } };
const WRONG_PASSWORD = {
  status: 401,
  body: { error: { code: 5100, message: "Authentication failed: incorrect password" } },
};

/** Databend Cloud's lockout as measured (I19): a 500 Unexpected wrapping the query node's 500 with 2215. */
const CLOUD_LOCKOUT = {
  status: 500,
  body: {
    error: {
      kind: "Unexpected",
      message:
        'status: 500, message: {"error":{"code":2215,"message":"Disable login before 2026-10-08 00:54:35.574391755 UTC because of too many password fails"}}: Unexpected',
    },
  },
};

/** A lockout as a query node answers it directly: HTTP 500 with 2215 (L10). */
const LOCKOUT = {
  status: 500,
  body: {
    error: { code: 2215, message: "Disable login before 2026-10-08 02:15:00 UTC because of too many password fails" },
  },
};

/** The latched sentence of the first run's refusal, at the harness's start time. */
const LATCHED = S.latched("2026-10-08 02:00", "2026-10-08 02:15");

/** Each request as its method and path, a statement's id read as `<id>`. */
const sent = (requests: readonly { readonly method: string; readonly path: string }[]) =>
  requests.map(({ method, path }) => `${method} ${path.replace(/[0-9a-f]{32}/, "<id>")}`);

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

function sharedLatch() {
  let now = TEST_START;
  return {
    latch: createAuthLatch({ now: () => now }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("a refused sign-in", () => {
  test("is sent once: a 401 POST is the only request, then the key refuses with no request", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: WRONG_PASSWORD }]);
    const refused = await failure(transport.run(statement("SELECT 1")));
    expect(refused.category).toBe("auth");
    expect(refused.message).toBe(`${S.signInRefused} Authentication failed: incorrect password.`);
    expect(script.requests).toHaveLength(1);
    // Basic is always sent (I10).
    expect(script.requests[0].headers.authorization).toStartWith("Basic ");

    const latched = await failure(transport.run(statement("SELECT 1")));
    expect(latched.category).toBe("auth");
    expect(latched.message).toBe(S.latched("2026-10-08 02:00", "2026-10-08 02:15"));
    expect(script.requests).toHaveLength(1);
    script.expectDone();
  });

  test("two instances on one key send nothing for 15 minutes, then the next attempt goes out", async () => {
    const shared = sharedLatch();
    const one = transportHarness([{ method: "POST", path: "/v1/query", reply: WRONG_PASSWORD }], {
      latch: shared.latch,
    });
    // The refused run drew the first ids, so the run that goes out is the second.
    const two = transportHarness([{ method: "POST", path: "/v1/query", reply: ok(idsOf(2)) }], { latch: shared.latch });
    await failure(one.transport.run(statement("SELECT 1")));
    expect((await failure(two.transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect(two.script.requests).toHaveLength(0);

    shared.advance(AUTH_LATCH_TTL_MS);
    await two.transport.run(statement("SELECT 1"));
    two.script.expectDone();
  });

  test("two transports built without a latch share the process's one latch: the second sends nothing", async () => {
    // A user no other test signs in as, so the process latch holds no key of another test.
    const options = testOptions({ user: "process-latch" });
    const built = (steps: Parameters<typeof scriptedNodeTransport>[0]) => {
      const script = scriptedNodeTransport(steps);
      // Every injection but the latch, so the transport takes the production one.
      const { createNodeTransport, sleep, random, now, newId, deadline } = transportDeps(script).deps;
      const deps = { createNodeTransport, sleep, random, now, newId, deadline };
      return { script, transport: createDatabendHttpTransport(options, deps) };
    };
    const one = built([{ method: "POST", path: "/v1/query", reply: WRONG_PASSWORD }]);
    const two = built([]);
    await failure(one.transport.run(statement("SELECT 1")));
    expect((await failure(two.transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect(two.script.requests).toHaveLength(0);
    two.script.expectDone();
  });

  test("2215 over HTTP 500 latches and adds the possible lockout", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 500, body: { error: { code: 2215, message: "locked" } } } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    expect(error.message).toBe(`${S.signInRefused} locked. ${S.possibleLockout}`);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    expect(script.requests).toHaveLength(1);
  });

  test("an in-body 2215, also a complexity error, does not latch", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { state: "Failed", error: { code: 2215, message: "password too simple" } }),
      },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    expect((await failure(transport.run(statement("ALTER USER u IDENTIFIED BY 'x'")))).category).toBe("statement");
    await transport.run(statement("SELECT 1"));
    script.expectDone();
  });

  test("a gateway's PasswordAuthFailed latches and says the console login is not a SQL user", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: { status: 403, body: { kind: "PasswordAuthFailed", message: "no" } },
      },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toBe(
      `${S.signInRefused} no. ${S.cloudSqlUser}`,
    );
    await failure(transport.run(statement("SELECT 1")));
    expect(script.requests).toHaveLength(1);
  });

  test("a Databend Cloud AuthorizationFailed on the POST latches: the next statement sends nothing (I19)", async () => {
    const { script, transport } = transportHarness(
      [
        {
          method: "POST",
          path: "/v1/query",
          reply: {
            status: 401,
            body: {
              error: {
                kind: "AuthorizationFailed",
                message:
                  'status: 401, message: {"error":{"code":5100,"message":"Authentication failed: incorrect password"}}: Authorization failed',
              },
            },
          },
        },
      ],
      { options: testOptions({ warehouse: "default" }) },
    );
    const refused = await failure(transport.run(statement("SELECT 1")));
    expect(refused.category).toBe("auth");
    expect(refused.message).toBe(`${S.signInRefused} Authentication failed: incorrect password. ${S.cloudSqlUser}`);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    expect(script.requests).toHaveLength(1);
    script.expectDone();
  });

  test("a Databend Cloud ForbiddenAccessUser refuses the statement and does not latch: the next one is sent (I19)", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: { status: 403, body: { error: { kind: "ForbiddenAccessUser", message: "Permission denied" } } },
      },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    const refused = await failure(transport.run(statement("SHOW WAREHOUSES")));
    expect(refused.category).toBe("statement");
    expect(refused.message).toBe(S.statementForbidden("Permission denied"));
    await transport.run(statement("SELECT 1"));
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a Databend Cloud lockout, wrapped under the Unexpected kind, latches on the POST: one request (I19)", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: CLOUD_LOCKOUT }], {
      options: testOptions({ warehouse: "default" }),
    });
    const refused = await failure(transport.run(statement("SELECT 1")));
    expect(refused.category).toBe("auth");
    expect(refused.message).toContain(S.possibleLockout);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toBe(
      S.latched("2026-10-08 02:00", "2026-10-08 02:15"),
    );
    expect(script.requests).toHaveLength(1);
    script.expectDone();
  });

  test("a Databend Cloud lockout on a page latches, and no kill, ROLLBACK or logout repeats the credential", async () => {
    const P = pathsOf(FIRST.queryId);
    const session = { txn_state: "Active", need_keep_alive: true, settings: { http_json_result_mode: "display" } };
    const { script, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", session, next_uri: P.page(0) }) },
        { method: "GET", path: P.page(0), reply: CLOUD_LOCKOUT },
      ],
      { options: testOptions({ warehouse: "default" }) },
    );
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect((await failure(transport.run(statement("SELECT 1")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a sign-in refused on a page also latches, and no kill, ROLLBACK or logout repeats the credential", async () => {
    const P = pathsOf(FIRST.queryId);
    const session = { txn_state: "Active", need_keep_alive: true, settings: { http_json_result_mode: "display" } };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", session, next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: WRONG_PASSWORD },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect((await failure(transport.run(statement("SELECT 1")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    script.expectDone();
  });
});

describe("a 401 with no sign-in code (design 3.13)", () => {
  test("on the POST is the request refused before it ran, never a follow-up, sends nothing more and does not latch", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 401, body: "Unauthorized", contentType: "text/plain" } },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    const refused = await failure(transport.run(statement("SELECT 1")));
    expect(refused.category).toBe("protocol");
    expect(refused.message).toBe(S.middlewareRefused("Unauthorized"));
    await transport.run(statement("SELECT 2"));
    expect(sent(script.requests)).toEqual(["POST /v1/query", "POST /v1/query"]);
    script.expectDone();
  });

  test("on a page is a refused follow-up request, killed, and does not latch", async () => {
    const P = pathsOf(FIRST.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { status: 401, body: { error: { code: 5104, message: "mismatch" } } } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    const refused = await failure(transport.run(statement("SELECT 1")));
    expect(refused.category).toBe("protocol");
    expect(refused.message).toBe(S.followUpRefused);
    await transport.run(statement("SELECT 2"));
    script.expectDone();
  });
});

describe("a refused sign-in on a close (HASIM-D-1)", () => {
  test("a cancel before the first answer whose kill is refused sends no logout, and the next statement nothing (P1)", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: pathsOf(FIRST.queryId).kill, reply: WRONG_PASSWORD },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.cancel();
    const first = await running;
    // The kill was refused, so the statement may have run: the stop is still the run's error.
    expect(first.category).toBe("outcome-unknown");
    expect(first.message).toBe(S.noAnswer(S.cancelledBeforeAnswer));
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(sent(script.requests)).toEqual(["POST /v1/query", "GET /v1/query/<id>/kill"]);
    script.expectDone();
  });

  test("the statement deadline before the first answer, with the kill refused, sends no logout either", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: pathsOf(FIRST.queryId).kill, reply: WRONG_PASSWORD },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { origin: "provider", signal: run.signal })));
    await script.received(1);
    run.expire();
    expect((await running).category).toBe("timeout");
    expect((await failure(transport.run(statement("SELECT 2", { origin: "provider" })))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a proxy's 502 on the POST, then a refused kill: no logout, and the next statement sends nothing (P1b)", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: { status: 502, body: "<html>bad gateway</html>", contentType: "text/html" },
      },
      { method: "GET", path: pathsOf(FIRST.queryId).kill, reply: WRONG_PASSWORD },
    ]);
    const first = await failure(transport.run(statement("SELECT 1")));
    expect(first.category).toBe("outcome-unknown");
    expect(first.message).toBe(S.noAnswer("HTTP 502"));
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test.each([
    ["a lockout over HTTP 500 (P2)", LOCKOUT],
    ["a password changed while the statement ran", WRONG_PASSWORD],
  ])("a cancel after a Running answer whose kill is %s sends no ROLLBACK and no logout", async (_label, refused) => {
    const P = pathsOf(FIRST.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", session: OPEN, next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { hang: true } },
      { method: "GET", path: P.kill, reply: refused },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(2);
    run.cancel();
    const first = await running;
    expect(first.category).toBe("outcome-unknown");
    expect(first.message).toBe(S.cancelUnanswered);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    expect(sent(script.requests)).toEqual(["POST /v1/query", "GET /v1/query/<id>/page/0", "GET /v1/query/<id>/kill"]);
    script.expectDone();
  });

  test("a kill resent after a 404 and then refused is not sent again, and no logout follows", async () => {
    const P = pathsOf(FIRST.queryId);
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 404 } },
      { method: "GET", path: P.kill, reply: WRONG_PASSWORD },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.cancel();
    expect((await running).category).toBe("outcome-unknown");
    expect(time.sleeps).toEqual([250]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(3);
    script.expectDone();
  });

  test("a final refused on a finished statement is a notice, closes nothing more, and the next statement sends nothing", async () => {
    const P = pathsOf(FIRST.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: OPEN, next_uri: P.final }) },
      { method: "GET", path: P.final, reply: WRONG_PASSWORD },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    // The ROLLBACK and the logout were not sent, so the transaction may stay open and the session was not ended:
    // the logout was skipped, never left unanswered.
    expect(outcome.notices).toEqual([
      { kind: "close-refused", step: "final" },
      { kind: "transaction-may-stay-open" },
      { kind: "close-skipped", step: "logout" },
    ]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a ROLLBACK refused as a sign-in is the last request: no logout, and the next statement sends nothing", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: OPEN }) },
      { method: "POST", path: "/v1/query", reply: LOCKOUT },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    expect(outcome.notices).toEqual([{ kind: "transaction-may-stay-open" }, { kind: "close-skipped", step: "logout" }]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toStartWith(
      "Databend refused this sign-in at",
    );
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a ROLLBACK link refused as a sign-in ends the chain, and no logout follows", async () => {
    const rollback = { queryId: testQueryId(4), sessionId: FIRST.sessionId };
    const R = pathsOf(rollback.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: OPEN }) },
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(rollback, { session: { ...OPEN, txn_state: "AutoCommit" }, next_uri: R.final }),
      },
      { method: "GET", path: R.final, reply: WRONG_PASSWORD },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    expect(outcome.notices).toEqual([
      { kind: "transaction-ended" },
      { kind: "close-refused", step: "rollback" },
      { kind: "close-skipped", step: "logout" },
    ]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(3);
    script.expectDone();
  });

  test("a logout refused as a sign-in latches: the next statement sends nothing", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: { ...OPEN, txn_state: "AutoCommit" } }) },
      { method: "POST", path: LOGOUT, reply: WRONG_PASSWORD },
    ]);
    expect((await transport.run(statement("CREATE TEMP TABLE t (a INT)"))).notices).toEqual([
      { kind: "close-refused", step: "logout" },
    ]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a run waiting on the unproven key goes only after the first run's kill and logout", async () => {
    const P = pathsOf(FIRST.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    const holder = runSignal();
    const holding = failure(transport.run(statement("SELECT 1", { signal: holder.signal })));
    await script.received(1);
    const waiting = transport.run(statement("SELECT 2"));
    holder.cancel();
    expect((await holding).category).toBe("cancelled");
    await waiting;
    expect(sent(script.requests)).toEqual([
      "POST /v1/query",
      "GET /v1/query/<id>/kill",
      "POST /v1/session/logout",
      "POST /v1/query",
    ]);
    script.expectDone();
  });
});

describe("a gateway refusal over HTTP 200 (HASIM-D-3)", () => {
  test("a sign-in refusal latches: three statements send one request (P3)", async () => {
    const refusedOver200 = {
      status: 200,
      body: {
        error: {
          kind: "AuthorizationFailed",
          message:
            'status: 401, message: {"error":{"code":5100,"message":"Authentication failed: incorrect password"}}: Authorization failed',
        },
      },
    };
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: refusedOver200 }]);
    const categories: string[] = [];
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 3"]) {
      // oxlint-disable-next-line no-await-in-loop -- each statement runs after the one before it settled the latch.
      categories.push((await failure(transport.run(statement(sql)))).category);
    }
    expect(categories).toEqual(["auth", "auth", "auth"]);
    expect(script.requests).toHaveLength(1);
    script.expectDone();
  });

  test("a resuming warehouse still refused after its retries proves nothing: the next run still flies alone", async () => {
    const resuming = { status: 200, body: { error: { kind: "ProvisionWarehouseTimeout", message: "resuming" } } };
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: resuming }], {
      options: testOptions({ warehouse: "wh" }, { queryTimeout: 1000 }),
    });
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("unavailable");
    // Unproven, the key admits one run at a time: the second waits while the first is in flight.
    script.push({ method: "POST", path: "/v1/query", reply: { hang: true } });
    const first = runSignal();
    const running = failure(transport.run(statement("SELECT 2", { signal: first.signal })));
    await script.received(2);
    const second = runSignal();
    const waiting = failure(transport.run(statement("SELECT 3", { signal: second.signal })));
    // A proven key would let it send its POST at once.
    await new Promise((resolve) => setImmediate(resolve));
    expect(script.requests).toHaveLength(2);
    second.cancel();
    expect((await waiting).category).toBe("cancelled");
    expect(script.requests).toHaveLength(2);
    script.push(
      { method: "GET", path: pathsOf(idsOf(2).queryId).kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    );
    first.cancel();
    await running;
    script.expectDone();
  });
});

describe("a gateway's sign-in refusal over HTTP 200 on a close (REV-T-2)", () => {
  const REFUSED_OVER_200 = {
    status: 200,
    body: { error: { kind: "AuthorizationFailed", message: "Authorization failed" } },
  };

  test("a kill answered so is no acknowledged kill: no logout follows, and the next statement sends nothing", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "GET", path: pathsOf(FIRST.queryId).kill, reply: REFUSED_OVER_200 },
    ]);
    const run = runSignal();
    const running = failure(transport.run(statement("SELECT 1", { signal: run.signal })));
    await script.received(1);
    run.cancel();
    const first = await running;
    expect(first.category).toBe("outcome-unknown");
    expect(first.message).toBe(S.noAnswer(S.cancelledBeforeAnswer));
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(sent(script.requests)).toEqual(["POST /v1/query", "GET /v1/query/<id>/kill"]);
    script.expectDone();
  });

  test("a final answered so is a notice, and the next statement sends nothing", async () => {
    const P = pathsOf(FIRST.queryId);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { next_uri: P.final }) },
      { method: "GET", path: P.final, reply: REFUSED_OVER_200 },
    ]);
    expect((await transport.run(statement("SELECT 1"))).notices).toEqual([{ kind: "close-refused", step: "final" }]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a logout answered so drops no temporary table, and the next statement sends nothing", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: { ...OPEN, txn_state: "AutoCommit" } }) },
      { method: "POST", path: LOGOUT, reply: REFUSED_OVER_200 },
    ]);
    expect((await transport.run(statement("CREATE TEMP TABLE t (a INT)"))).notices).toEqual([
      { kind: "close-refused", step: "logout" },
    ]);
    expect((await failure(transport.run(statement("SELECT 2")))).message).toBe(LATCHED);
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });
});

describe("the key (X03)", () => {
  test("two transports through two tunnels to one far end share it: the second sends nothing", async () => {
    const shared = sharedLatch();
    // The far end and the bastion route, as Studio's provider factory hands them to a tunnelled provider.
    const tunnel = { farEnd: { host: "databend.internal", port: 8000 }, route: "4:true12:bastion.test2:224:jump" };
    const first = transportHarness([{ method: "POST", path: "/v1/query", reply: WRONG_PASSWORD }], {
      latch: shared.latch,
      options: testOptions({ port: 41001 }, { tunnel }),
    });
    const second = transportHarness([], {
      latch: shared.latch,
      options: testOptions({ port: 41002 }, { tunnel }),
    });
    expect(first.options.origin.port).not.toBe(second.options.origin.port);
    await failure(first.transport.run(statement("SELECT 1")));
    expect((await failure(second.transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect(second.script.requests).toHaveLength(0);
  });
});

describe("single flight (X14)", () => {
  test("two concurrent runs on an unproven key against a 401: one request, both refused", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: WRONG_PASSWORD }]);
    const [one, two] = await Promise.all([
      failure(transport.run(statement("SELECT 1"))),
      failure(transport.run(statement("SELECT 2"))),
    ]);
    expect(one.category).toBe("auth");
    expect(two.category).toBe("auth");
    expect(script.requests).toHaveLength(1);
    script.expectDone();
  });

  test("a proven key never waits: two runs are in flight at once", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST) },
      { method: "POST", path: "/v1/query", reply: { hang: true } },
      { method: "POST", path: "/v1/query", reply: { hang: true } },
    ]);
    await transport.run(statement("SELECT 1"));
    const first = runSignal();
    const second = runSignal();
    const runs = [
      transport.run(statement("SELECT 2", { signal: first.signal })).catch((error: unknown) => error),
      transport.run(statement("SELECT 3", { signal: second.signal })).catch((error: unknown) => error),
    ];
    await script.received(3);
    expect(script.requests).toHaveLength(3);
    script.push(
      { method: "GET", path: pathsOf(idsOf(2).queryId).kill, reply: { status: 200 } },
      { method: "POST", path: "/v1/session/logout", reply: { status: 200 } },
      { method: "GET", path: pathsOf(idsOf(3).queryId).kill, reply: { status: 200 } },
      { method: "POST", path: "/v1/session/logout", reply: { status: 200 } },
    );
    first.cancel();
    await runs[0];
    second.cancel();
    await runs[1];
    script.expectDone();
  });

  test.each([
    ["a cancel", "cancel", "cancelled", S.cancelled],
    ["the statement deadline", "expire", "timeout", S.deadline("60")],
  ] as const)(
    "a wait cut short by %s is that stop, and nothing is sent (I18)",
    async (_label, how, category, message) => {
      const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: { hang: true } }]);
      const holder = runSignal();
      const holding = transport.run(statement("SELECT 1", { signal: holder.signal })).catch((error: unknown) => error);
      await script.received(1);
      const waiter = runSignal();
      const waiting = failure(transport.run(statement("SELECT 2", { signal: waiter.signal })));
      waiter[how]();
      const error = await waiting;
      expect(error.category).toBe(category);
      expect(error.message).toBe(message);
      expect(script.requests).toHaveLength(1);
      script.push(
        { method: "GET", path: pathsOf(FIRST.queryId).kill, reply: { status: 200 } },
        { method: "POST", path: "/v1/session/logout", reply: { status: 200 } },
      );
      holder.cancel();
      await holding;
      script.expectDone();
    },
  );

  test("a run whose signal fired before it was sent is that stop, with nothing sent", async () => {
    const { script, transport } = transportHarness([]);
    const stopped = runSignal();
    stopped.cancel();
    expect((await failure(transport.run(statement("SELECT 1", { signal: stopped.signal })))).category).toBe(
      "cancelled",
    );
    expect(script.requests).toHaveLength(0);
  });
});
