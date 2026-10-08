/**
 * The client session and the end-open of design 3.4 and 3.7 (C11; X13): only the statement's own session is ever
 * sent, an `Active` transaction is rolled back under a new query id with its links followed inside the same 5 s and no
 * second end-open, a ROLLBACK link answered with a 200 it cannot read is a refused close and one with no answer a
 * failed one, a close whose answer the node transport refused to read is a refused one too, `Fail` sends nothing, a
 * session that still needs keep-alive is logged out, and a POST with no answer gets one kill and one logout with our
 * session id. A provider statement's outcome names the query ids of this process's own provider statements in flight
 * while it ran, its own included, each kept from before its POST until its last close.
 */
import { describe, expect, test } from "bun:test";
import { type NodeResponse, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import { DATABEND_ERROR_SENTENCES as S, DATABEND_PROTOCOL_FAULTS as F } from "@/lib/db/providers/sql/databend/errors";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import { serverText } from "@/lib/db/utils/server-text";
import {
  answerBody,
  capturedAnswer,
  idsOf,
  ok,
  pathsOf,
  scriptedNodeTransport,
  statement,
  TEST_NODE,
  TEST_PASSWORD,
  testOptions,
  testQueryId,
  transportDeps,
  transportHarness,
  wireIds,
} from "../../../helpers/databend-node-transport";

const FIRST = idsOf(1);
const P = pathsOf(FIRST.queryId);
/** The ROLLBACK's query id: the next draw after the statement's three. */
const ROLLBACK_ID = testQueryId(4);
const R = pathsOf(ROLLBACK_ID);
const LOGOUT = "/v1/session/logout";

function echo(fields: Record<string, unknown>) {
  return {
    catalog: "default",
    database: "default",
    role: "account_admin",
    settings: { http_json_result_mode: "display" },
    txn_state: "AutoCommit",
    need_sticky: false,
    need_keep_alive: false,
    ...fields,
  };
}

const ACTIVE = echo({ txn_state: "Active", need_sticky: true, need_keep_alive: true, internal: "{}" });

describe("the client session (C11)", () => {
  test("every request of a statement carries its one session, and the next statement another", async () => {
    const second = idsOf(2);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { next_uri: P.final }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
      { method: "POST", path: "/v1/query", reply: ok(second) },
    ]);
    await transport.run(statement("SELECT 1"));
    await transport.run(statement("SELECT 2"));
    script.expectDone();
    const sessions = script.requests.map((request) => request.headers["x-databend-session"]);
    expect(new Set(sessions.slice(0, 3)).size).toBe(1);
    expect(sessions[3]).not.toBe(sessions[0]);
  });

  test("an echoed session is never kept: the next statement's body carries none", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: echo({ database: "elsewhere" }) }) },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
    ]);
    await transport.run(statement("USE elsewhere"));
    await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(JSON.parse(script.requests[1].body as string).session).toEqual(
      JSON.parse(script.requests[0].body as string).session,
    );
  });
});

describe("an Active transaction (design 3.4; X13)", () => {
  test("is rolled back under a new id with the echoed session verbatim, its final followed, and no logout after", async () => {
    const begin = capturedAnswer("begin", 0, {
      "<query-12>": FIRST.queryId,
      "<session-4>": FIRST.sessionId,
      "<node-1>": TEST_NODE,
    });
    const echoed = JSON.parse(begin.body).session;
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: begin },
      { method: "GET", path: P.final, reply: ok(FIRST) },
      {
        method: "POST",
        path: "/v1/query",
        reply: ok({ queryId: ROLLBACK_ID, sessionId: FIRST.sessionId }, { session: echo({}), next_uri: R.final }),
      },
      { method: "GET", path: R.final, reply: ok({ queryId: ROLLBACK_ID, sessionId: FIRST.sessionId }) },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    const [, , rollback, followed] = script.requests;
    expect(JSON.parse(rollback.body as string)).toEqual({
      sql: "ROLLBACK",
      session: echoed,
      pagination: { wait_time_secs: 2 },
    });
    expect(rollback.headers["x-databend-query-id"]).toBe(ROLLBACK_ID);
    expect(rollback.headers["x-databend-query-id"]).not.toBe(FIRST.queryId);
    expect(rollback.headers["x-databend-session"]).toBe(script.requests[0].headers["x-databend-session"]);
    expect(rollback.headers["x-databend-sticky-node"]).toBe(TEST_NODE);
    expect(followed.headers["x-databend-sticky-node"]).toBe(TEST_NODE);
    // The capture sent no settings, so its echo also gives the floor warning (I6).
    expect(outcome.notices).toEqual([{ kind: "result-mode", mode: "" }, { kind: "transaction-ended" }]);
    // The final and the ROLLBACK each took one 5 s budget; the ROLLBACK's links shared its own.
    expect(time.deadlines.map((deadline) => deadline.ms)).toEqual([5000, 5000]);
  });

  test("a ROLLBACK that still reports Active gets no second end-open: one ROLLBACK, may stay open", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      {
        method: "POST",
        path: "/v1/query",
        reply: ok({ queryId: ROLLBACK_ID, sessionId: FIRST.sessionId }, { session: ACTIVE }),
      },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-may-stay-open" }, { kind: "temp-tables-dropped" }]);
  });

  test("a ROLLBACK answered under another id may leave the transaction open", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: echo({}) }) },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-may-stay-open" }]);
  });

  test("a ROLLBACK with no answer may leave the transaction open, and the session is logged out", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: { fail: "network" } },
      { method: "POST", path: LOGOUT, reply: { status: 500 } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-may-stay-open" }, { kind: "close-refused", step: "logout" }]);
  });

  test("a ROLLBACK refused with a status may leave the transaction open", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: { status: 503 } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices[0]).toEqual({ kind: "transaction-may-stay-open" });
  });

  test("the ROLLBACK's pages are followed to the end; a link it does not accept is a close failure", async () => {
    const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: ok(rollback, { session: echo({}), next_uri: R.page(0) }) },
      { method: "GET", path: R.page(0), reply: ok(rollback, { next_uri: "/v1/query/elsewhere/final" }) },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-ended" }, { kind: "close-failed", step: "rollback" }]);
  });

  test("the ROLLBACK's chain stops at its poll bound, one per second of its 5 s and the allowance: 105 GETs", async () => {
    const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
    // A server that answers every link at once with another one; the scripted clock never runs the 5 s out.
    const again = { method: "GET" as const, path: R.page(0), reply: ok(rollback, { next_uri: R.page(0) }) };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: ok(rollback, { session: echo({}), next_uri: R.page(0) }) },
      ...Array.from({ length: 105 }, () => again),
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(script.requests).toHaveLength(2 + 105);
    expect(outcome.notices).toEqual([{ kind: "transaction-ended" }, { kind: "close-failed", step: "rollback" }]);
  });

  test("a ROLLBACK link answered with an error within its 5 s is a refused close", async () => {
    const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: ok(rollback, { session: echo({}), next_uri: R.final }) },
      { method: "GET", path: R.final, reply: { status: 500, body: "panic", contentType: "text/plain" } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-ended" }, { kind: "close-refused", step: "rollback" }]);
  });

  test.each([
    ["a body that does not parse", { status: 200, body: "<html>" }],
    ["a body that is not JSON", { status: 200, body: "<html>", contentType: "text/html" }],
    ["a field of the wrong type", { status: 200, body: { id: ROLLBACK_ID, state: 7 } }],
    [
      "nesting past its bound",
      { status: 200, body: `{"id":"x","state":"Running","x":${"[".repeat(70)}${"]".repeat(70)}}` },
    ],
  ])(
    "a ROLLBACK link answered with %s was answered: a refused close, never one that got no answer",
    async (_label, reply) => {
      const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
      const { script, transport } = transportHarness([
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
        { method: "POST", path: "/v1/query", reply: ok(rollback, { session: echo({}), next_uri: R.page(0) }) },
        { method: "GET", path: R.page(0), reply },
      ]);
      const outcome = await transport.run(statement("BEGIN"));
      script.expectDone();
      expect(outcome.notices).toEqual([{ kind: "transaction-ended" }, { kind: "close-refused", step: "rollback" }]);
    },
  );

  test("a ROLLBACK link that gets no answer is a failed close", async () => {
    const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: ok(rollback, { session: echo({}), next_uri: R.page(0) }) },
      { method: "GET", path: R.page(0), reply: { fail: "network" } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-ended" }, { kind: "close-failed", step: "rollback" }]);
  });

  test("a ROLLBACK answered with a 200 it cannot read may leave the transaction open, and the session is logged out", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE }) },
      { method: "POST", path: "/v1/query", reply: { status: 200, body: "<html>" } },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const outcome = await transport.run(statement("BEGIN"));
    script.expectDone();
    expect(outcome.notices).toEqual([{ kind: "transaction-may-stay-open" }, { kind: "temp-tables-dropped" }]);
  });

  test("a ROLLBACK that hangs is cut by its own 5 s deadline", async () => {
    const { script, time, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: echo({ txn_state: "Active" }) }) },
      { method: "POST", path: "/v1/query", reply: { hang: true } },
    ]);
    const running = transport.run(statement("BEGIN"));
    await script.received(2);
    time.fire(5000);
    expect((await running).notices).toEqual([{ kind: "transaction-may-stay-open" }]);
    script.expectDone();
  });

  test("Fail sends nothing: only an Active transaction is kept", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: echo({ txn_state: "Fail" }) }) },
    ]);
    expect((await transport.run(statement("SELECT 1"))).notices).toEqual([]);
    script.expectDone();
  });
});

describe("a close whose answer the node transport refused to read (Z3)", () => {
  test.each([
    ["an answer past the cap", { fail: "too-large" as const }, 1],
    ["an answer under a content-encoding other than identity", { fail: "encoding" as const }, 1],
    ["a redirect", { fail: "redirect" as const }, 1],
    // A network failure is a GET's to retry, so the final is asked for three times.
    ["an answer cut short once it began", { fail: "network" as const, truncated: true }, 3],
  ])(
    "%s to the final, a ROLLBACK link and the logout arrived, so each is a refused close, never an unanswered one",
    async (_label, reply, finals) => {
      const rollback = { queryId: ROLLBACK_ID, sessionId: FIRST.sessionId };
      const final = { method: "GET" as const, path: P.final, reply };
      const { script, transport } = transportHarness([
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: ACTIVE, next_uri: P.final }) },
        ...Array.from({ length: finals }, () => final),
        {
          method: "POST",
          path: "/v1/query",
          reply: ok(rollback, { session: echo({ need_keep_alive: true }), next_uri: R.page(0) }),
        },
        { method: "GET", path: R.page(0), reply },
        { method: "POST", path: LOGOUT, reply },
      ]);
      const outcome = await transport.run(statement("BEGIN"));
      script.expectDone();
      expect(outcome.notices).toEqual([
        { kind: "close-refused", step: "final" },
        { kind: "transaction-ended" },
        { kind: "close-refused", step: "rollback" },
        { kind: "close-refused", step: "logout" },
      ]);
    },
  );
});

describe("an echoed session nested past what an answer may have (REV-T-1)", () => {
  test("is a protocol fault before it is parsed: killed and logged out, and no ROLLBACK stringifies it", async () => {
    // Written as text: JSON.stringify overflows on 50,000 levels, in this test as in the ROLLBACK's body.
    const deep = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    const session = `{"txn_state":"Active","need_keep_alive":false,"settings":{"http_json_result_mode":"display"},"x":${deep}}`;
    const body = `{"id":"${FIRST.queryId}","session_id":"${FIRST.sessionId}","node_id":"${TEST_NODE}","state":"Succeeded","session":${session},"schema":[],"data":[]}`;
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 200, body } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      // The answer was not read, so its session may hold a temporary table: the logout has no body to stringify.
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    const error = await transport.run(statement("SELECT version()")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabendError);
    expect((error as DatabendError).category).toBe("protocol");
    expect((error as DatabendError).message).toBe(S.protocol(F.depth));
    script.expectDone();
    expect(script.requests[2].body).toBeUndefined();
  });
});

describe("temporary tables (design 3.4, UC5)", () => {
  test("a session that needs keep-alive is logged out with the statement's headers, which drops its tables", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { session: echo({ need_keep_alive: true }), next_uri: P.final }),
      },
      { method: "GET", path: P.final, reply: ok(FIRST, { session: null }) },
      { method: "POST", path: LOGOUT, reply: { status: 200, body: "", contentType: null } },
    ]);
    const outcome = await transport.run(statement("CREATE TEMP TABLE t (a INT)"));
    script.expectDone();
    const logout = script.requests[2];
    expect(logout.body).toBeUndefined();
    expect(logout.headers["x-databend-session"]).toBe(script.requests[0].headers["x-databend-session"]);
    expect(logout.headers["x-databend-sticky-node"]).toBe(TEST_NODE);
    expect(outcome.notices).toEqual([{ kind: "temp-tables-dropped" }]);
  });

  test("a failed logout is a notice", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session: echo({ need_keep_alive: true }) }) },
      { method: "POST", path: LOGOUT, reply: { fail: "network" } },
    ]);
    expect((await transport.run(statement("CREATE TEMP TABLE t (a INT)"))).notices).toEqual([
      { kind: "close-failed", step: "logout" },
    ]);
    script.expectDone();
  });

  test("an in-body error still ends the session it left open", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, {
          state: "Failed",
          error: { code: 1025, message: "Unknown table" },
          session: echo({ need_keep_alive: true }),
          next_uri: P.final,
        }),
      },
      { method: "GET", path: P.final, reply: ok(FIRST) },
      { method: "POST", path: LOGOUT, reply: { status: 200 } },
    ]);
    await expect(transport.run(statement("SELECT a FROM t"))).rejects.toBeInstanceOf(DatabendError);
    script.expectDone();
  });
});

describe("server text in a notice (HASIM-D-5)", () => {
  test("an echoed result mode and a SET GLOBAL key that hold the password are withheld, as a server warning is", async () => {
    const { script, options, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, {
          session: echo({ settings: { http_json_result_mode: `x ${TEST_PASSWORD}` } }),
          affect: { type: "ChangeSettings", keys: [TEST_PASSWORD], values: ["1"], is_globals: [true] },
          warnings: [`w ${TEST_PASSWORD}`],
        }),
      },
    ]);
    const outcome = await transport.run(statement("SET GLOBAL max_threads = 1"));
    script.expectDone();
    const withheld = serverText(TEST_PASSWORD, options.secretForms);
    expect(outcome.notices).toEqual([
      { kind: "global-settings-changed", keys: [withheld] },
      { kind: "server-warning", text: withheld },
      { kind: "result-mode", mode: withheld },
    ]);
  });

  test("an echoed result mode is cut at 300 characters, as a refusal's text is", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { session: echo({ settings: { http_json_result_mode: "m".repeat(400) } }) }),
      },
    ]);
    expect((await transport.run(statement("SELECT 1"))).notices).toEqual([
      { kind: "result-mode", mode: `${"m".repeat(300)}...` },
    ]);
    script.expectDone();
  });
});

describe("a POST with no answer (X13)", () => {
  test("whose socket dies after its body gets one kill and one logout with our session id, a failed logout ignored", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { fail: "network" } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT, reply: { status: 500 } },
    ]);
    const error = (await transport
      .run(statement("CREATE TEMP TABLE t (a INT)"))
      .catch((caught) => caught)) as DatabendError;
    script.expectDone();
    expect(error.category).toBe("outcome-unknown");
    const session = script.requests[0].headers["x-databend-session"];
    expect(script.requests[1].headers["x-databend-session"]).toBe(session);
    expect(script.requests[2].headers["x-databend-session"]).toBe(session);
    expect(script.requests[2].headers["x-databend-sticky-node"]).toBeUndefined();
  });
});

describe("Studio's own statements in flight (design 5.5, CL-OPS-1)", () => {
  const OK_TEXT = "{}";

  /**
   * A transport over a node transport that answers each statement POST with the ids it carries and a final link, a
   * statement starting `FAIL` with an in-body error, and each final with 200, every answer once `hold` of the
   * statement's text, or of the final's path, settles.
   */
  function heldTransport(hold: (what: string) => Promise<void> | undefined = () => undefined) {
    const time = transportDeps(scriptedNodeTransport());
    const node = (): NodeTransport => ({
      async request(request): Promise<NodeResponse> {
        if (request.signal.aborted) throw new TransportError("aborted", "The request was cancelled");
        const path = new URL(request.url).pathname;
        const sql = request.body === undefined ? undefined : (JSON.parse(request.body) as { sql: string }).sql;
        await hold(sql ?? path);
        if (sql === undefined) return { status: 200, contentType: "application/json", retryAfter: null, text: OK_TEXT };
        // A statement POST carries its own headers, the client session and the query id among them.
        const ids = wireIds({ ...request.headers });
        const failed = sql.startsWith("FAIL") ? { state: "Failed", error: { code: 1006, message: "failed" } } : {};
        const body = answerBody({
          id: ids.queryId,
          session_id: ids.sessionId,
          next_uri: `/v1/query/${ids.queryId}/final`,
          ...failed,
        });
        return { status: 200, contentType: "application/json", retryAfter: null, text: JSON.stringify(body) };
      },
      close() {},
    });
    return createDatabendHttpTransport(testOptions(), { ...time.deps, createNodeTransport: node });
  }

  const provider = (sql: string, signal?: AbortSignal) =>
    statement(sql, { origin: "provider", ...(signal === undefined ? {} : { signal }) });

  test("a provider statement's outcome names its own query id; a user statement's names none", async () => {
    const transport = heldTransport();
    const read = await transport.run(provider("SELECT 'read'"));
    const user = await transport.run(statement("SELECT 'user'"));
    expect(read.ownQueryIds).toEqual(new Set([idsOf(1).queryId]));
    expect(user.ownQueryIds).toBeUndefined();
  });

  test("a read names every own statement in flight while it ran, one that ended before its answer included", async () => {
    const read = Promise.withResolvers<void>();
    const earlier = Promise.withResolvers<void>();
    const transport = heldTransport((what) => {
      if (what === "SELECT 'read'") return read.promise;
      return what === "SELECT 'earlier'" ? earlier.promise : undefined;
    });
    const earlierRun = transport.run(provider("SELECT 'earlier'"));
    const readRun = transport.run(provider("SELECT 'read'"));
    earlier.resolve();
    const earlierOutcome = await earlierRun;
    // Began and ended while the read was still waiting for its answer.
    const sibling = await transport.run(provider("SELECT 'sibling'"));
    const user = await transport.run(statement("SELECT 'user'"));
    read.resolve();
    const readOutcome = await readRun;
    const [first, second, third] = [1, 2, 3].map((n) => idsOf(n).queryId);
    expect(readOutcome.ownQueryIds).toEqual(new Set([first, second, third]));
    expect(earlierOutcome.ownQueryIds).toEqual(new Set([first, second]));
    expect(sibling.ownQueryIds).toEqual(new Set([second, third]));
    expect(user.ownQueryIds).toBeUndefined();
    // Nothing is left in flight: the next statement names only itself.
    expect((await transport.run(provider("SELECT 'next'"))).ownQueryIds).toEqual(new Set([idsOf(5).queryId]));
  });

  test("a statement stays its own until its last close ends, and is forgotten once its run ends, however it ended", async () => {
    const closing = idsOf(1);
    const finalAsked = Promise.withResolvers<void>();
    const finalHeld = Promise.withResolvers<void>();
    const transport = heldTransport((what) => {
      if (what !== pathsOf(closing.queryId).final) return undefined;
      finalAsked.resolve();
      return finalHeld.promise;
    });
    const closingRun = transport.run(provider("SELECT 'closing'"));
    await finalAsked.promise;
    // Its answer arrived and its final is still out: it is still in flight.
    const during = await transport.run(provider("SELECT 'during'"));
    expect(during.ownQueryIds).toEqual(new Set([closing.queryId, idsOf(2).queryId]));
    finalHeld.resolve();
    await closingRun;
    expect(await transport.run(provider("FAIL")).catch((error: unknown) => error)).toBeInstanceOf(DatabendError);
    const stopped = new AbortController();
    stopped.abort();
    const unsent = await transport.run(provider("SELECT 'stopped'", stopped.signal)).catch((error: unknown) => error);
    expect((unsent as DatabendError).category).toBe("cancelled");
    expect((await transport.run(provider("SELECT 'after'"))).ownQueryIds).toEqual(new Set([idsOf(5).queryId]));
  });
});
