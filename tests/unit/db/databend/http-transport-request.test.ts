/**
 * The Databend HTTP transport's requests and its first answer (design 3.2 to 3.4; C6, C14, C17; X01, I6, I18), on the
 * scripted node transport with injected time: the closed statement body, the headers of every request, the checks the
 * first answer must pass before any page and every later page after it, the loop's result, and the notices it carries.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { DATABEND_ANSWER_SENTENCES } from "@/lib/db/providers/sql/databend/answer";
import {
  DATABEND_MAX_SOCKETS,
  DATABEND_REQUEST_HEADER_NAMES,
} from "@/lib/db/providers/sql/databend/connection-options";
import { DATABEND_ERROR_SENTENCES as S, DATABEND_PROTOCOL_FAULTS as F } from "@/lib/db/providers/sql/databend/errors";
import { DATABEND_WARNING_LIMIT } from "@/lib/db/providers/sql/databend/http-transport";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import { serverText } from "@/lib/db/utils/server-text";
import {
  answerBody,
  capturedAnswer,
  idsOf,
  ok,
  pathsOf,
  statement,
  TEST_NODE,
  TEST_PASSWORD,
  TEST_START,
  TEST_USER,
  testOptions,
  transportHarness,
} from "../../../helpers/databend-node-transport";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { QUERY_PATH } from "@/lib/db/providers/sql/databend/routes";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";

const FIRST = idsOf(1);
const P = pathsOf(FIRST.queryId);
const LOGOUT = "/v1/session/logout";

async function failure(promise: Promise<unknown>): Promise<DatabendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DatabendError);
    return error as DatabendError;
  }
  throw new Error("expected the run to fail");
}

describe("the statement body (design 3.3)", () => {
  test("is the closed object, every key exact, the Binary format pinned to hex [X01]", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: ok(FIRST) }], {
      options: testOptions({ database: "studio_demo" }),
    });
    await transport.run(statement("SELECT 1", { rowCut: 1000 }));
    script.expectDone();
    expect(JSON.parse(script.requests[0].body as string)).toEqual({
      sql: "SELECT 1",
      session: {
        database: "studio_demo",
        settings: {
          format_null_as_str: "0",
          http_json_result_mode: "display",
          binary_output_format: "hex",
          max_execute_time_in_seconds: "60",
        },
      },
      pagination: { wait_time_secs: 10, max_rows_per_page: 1001, max_rows_in_buffer: 2002 },
    });
  });

  test("leaves the database out when the connection has none", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: ok(FIRST) }]);
    await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(Object.keys(JSON.parse(script.requests[0].body as string).session)).toEqual(["settings"]);
  });

  test("a provider statement also pins the dialect, quoted case and UTC under the surface deadline [C17]", async () => {
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: ok(FIRST) }]);
    await transport.run(statement("SELECT 1", { origin: "provider" }));
    script.expectDone();
    expect(JSON.parse(script.requests[0].body as string).session.settings).toEqual({
      format_null_as_str: "0",
      http_json_result_mode: "display",
      binary_output_format: "hex",
      max_execute_time_in_seconds: "10",
      sql_dialect: "PostgreSQL",
      quoted_ident_case_sensitive: "1",
      timezone: "UTC",
    });
  });

  test("the deadline is whole seconds rounded up, and a page is never 0 nor over 10,000 rows", async () => {
    const { script, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST) },
        { method: "POST", path: "/v1/query", reply: ok(idsOf(2)) },
      ],
      { options: testOptions({}, { queryTimeout: 1500 }) },
    );
    await transport.run(statement("SELECT 1", { rowCut: 0 }));
    await transport.run(statement("SELECT 1", { rowCut: 100_000 }));
    script.expectDone();
    const [small, large] = script.requests.map((request) => JSON.parse(request.body as string));
    expect(small.session.settings.max_execute_time_in_seconds).toBe("2");
    expect(small.pagination).toEqual({ wait_time_secs: 10, max_rows_per_page: 1, max_rows_in_buffer: 2 });
    expect(large.pagination).toEqual({ wait_time_secs: 10, max_rows_per_page: 10_000, max_rows_in_buffer: 20_000 });
  });
});

describe("the headers (design 3.2)", () => {
  test("the node transport is built with the connection's headers, the closed per-request list and three sockets", () => {
    const options = testOptions({ warehouse: "wh_1" });
    const { script } = transportHarness([], { options });
    expect(script.built).toHaveLength(1);
    const [built] = script.built;
    expect(built.origin).toEqual(options.origin);
    expect(built.tls).toBeNull();
    expect(built.maxSockets).toBe(DATABEND_MAX_SOCKETS);
    // The egress decision the connection options were built with, by identity.
    expect(built.egress).toBe(options.egress);
    expect(built.egress).toBe(ALLOWS_PRIVATE_HOSTS);
    expect(built.requestHeaderNames).toEqual([...DATABEND_REQUEST_HEADER_NAMES]);
    expect(built.headers).toEqual({
      authorization: `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")}`,
      accept: "application/json",
      "user-agent": "libredb-studio/1.2.3",
      "x-databend-client-caps": "session_header",
      "x-databend-warehouse": "wh_1",
    });
  });

  test("the POST carries the client session, the query id and the route hint; the GETs add the sticky node", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { next_uri: P.final }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    await transport.run(statement("SELECT 1"));
    script.expectDone();
    const [post, page, final] = script.requests;
    const session = Buffer.from(post.headers["x-databend-session"], "base64url").toString("utf8");
    expect(JSON.parse(session)).toEqual({ id: FIRST.sessionId, last_refresh_time: Math.floor(TEST_START / 1000) });
    expect(post.headers["x-databend-query-id"]).toBe(FIRST.queryId);
    expect(post.headers["x-databend-query-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(post.headers["x-databend-route-hint"]).toBe(`rh:${FIRST.routeHint}:500000`);
    expect(post.headers["x-databend-sticky-node"]).toBeUndefined();
    for (const get of [page, final]) {
      expect(get.headers["x-databend-session"]).toBe(post.headers["x-databend-session"]);
      expect(get.headers["x-databend-route-hint"]).toBe(post.headers["x-databend-route-hint"]);
      expect(get.headers["x-databend-sticky-node"]).toBe(TEST_NODE);
      expect(get.headers["x-databend-query-id"]).toBeUndefined();
      expect(get.body).toBeUndefined();
    }
  });

  test("a CR or LF in User or Warehouse is refused before a transport is built [C6]", () => {
    for (const overrides of [{ user: "reader\r\nx-databend-tenant: t" }, { warehouse: "wh\nx" }]) {
      expect(() => transportHarness([], { options: testOptions(overrides) })).toThrow(DatabaseConfigError);
    }
  });
});

describe("the first answer (design 3.4)", () => {
  test("another session_id fails before any page: one kill, then protocol [C14]", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { session_id: "another", state: "Running", next_uri: P.page(0) }),
      },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("protocol");
    expect(error.message).toBe(S.protocol(F.sessionId));
    expect(script.requests[1].headers["x-databend-sticky-node"]).toBeUndefined();
  });

  test("an empty session_id says a proxy may have dropped the session header", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session_id: "" }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.message).toBe(S.protocol(F.proxySession));
  });

  test("an answer for another query id is killed and protocol", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok({ ...FIRST, queryId: "0".repeat(32) }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.message).toBe(S.protocol(F.queryId));
  });

  test.each([
    ["a CR LF node_id", "node\r\nx-evil: 1"],
    ["a missing node_id", null],
    ["a node_id over 64 characters", "n".repeat(65)],
  ])("%s stops the loop with a kill that carries no sticky node [C6]", async (_label, nodeId) => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { node_id: nodeId, next_uri: P.page(0) }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.message).toBe(S.protocol(F.field("node_id")));
    expect(script.requests[1].headers["x-databend-sticky-node"]).toBeUndefined();
  });

  test("a fail-to-start answer (id empty) is Databend's text, and nothing more is sent", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, {
          id: "",
          session_id: null,
          node_id: null,
          state: "Failed",
          error: { code: 1001, message: "Failed to upgrade session" },
        }),
      },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("statement");
    expect(error.message).toBe(`Failed to upgrade session ${S.nothingRan}`);
  });

  test("an id that is empty with no error is an answer for another statement", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { id: "" }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toBe(S.protocol(F.queryId));
    script.expectDone();
  });

  test("the session middleware's 400 on the POST is config, and nothing more is sent", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: { status: 400, body: { error: { code: 400, message: "bad session header" } } },
      },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("config");
    expect(error.message).toBe(S.middlewareRefused("bad session header"));
  });

  test.each([
    ["a 200 that does not parse", { status: 200, body: "<html>" }, F.notJson],
    ["a 200 that is not JSON", { status: 200, body: "<html>", contentType: "text/html" }, F.notAnswer],
    [
      "a 200 past its page",
      {
        status: 200,
        body: answerBody({
          id: FIRST.queryId,
          session_id: FIRST.sessionId,
          schema: [{ name: "a", type: "Int32" }],
          data: [["1"], ["2"], ["3"]],
        }),
      },
      F.rows,
    ],
  ])(
    "%s to the POST is protocol, killed and logged out: its session may hold a temporary table [X13]",
    async (_label, reply, fault) => {
      const { script, transport } = transportHarness([
        { method: "POST", path: "/v1/query", reply },
        { method: "GET", path: P.kill, reply: { status: 200 } },
        { method: "POST", path: LOGOUT, reply: { status: 200 } },
      ]);
      const error = await failure(transport.run(statement("CREATE TEMP TABLE t (a INT)", { rowCut: 1 })));
      script.expectDone();
      expect(error.category).toBe("protocol");
      expect(error.message).toBe(S.protocol(fault));
      // The logout ends the statement's own session, the one the server may hold the table in.
      expect(script.requests[2].headers["x-databend-session"]).toBe(script.requests[0].headers["x-databend-session"]);
    },
  );

  test("an unreadable 200 to the POST whose kill is refused as a sign-in sends no logout: the sign-in latched", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: { status: 200, body: "<html>" } },
      {
        method: "GET",
        path: P.kill,
        reply: { status: 401, body: { error: { code: 5100, message: "Authentication failed" } } },
      },
    ]);
    expect((await failure(transport.run(statement("CREATE TEMP TABLE t (a INT)")))).message).toBe(
      S.protocol(F.notJson),
    );
    expect((await failure(transport.run(statement("SELECT 1")))).category).toBe("auth");
    expect(script.requests).toHaveLength(2);
    script.expectDone();
  });

  test("a refusal of the node transport before any socket is config, and nothing more is sent", async () => {
    const refused = new DatabaseConfigError("Invalid host: refused by the egress policy");
    const { script, transport } = transportHarness([{ method: "POST", path: "/v1/query", reply: { throws: refused } }]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("config");
    expect(error.message).toBe(refused.message);
    expect(error.cause).toBe(refused);
  });
});

describe("the result", () => {
  test("replays the captured three-page SELECT: every row, the schema, one final GET", async () => {
    const values = {
      "<query-2>": FIRST.queryId,
      "<node-1>": TEST_NODE,
      '"session_id":""': `"session_id":"${FIRST.sessionId}"`,
    };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: capturedAnswer("select-pages", 0, values) },
      { method: "GET", path: P.page(1), reply: capturedAnswer("select-pages", 1, values) },
      { method: "GET", path: P.page(2), reply: capturedAnswer("select-pages", 2, values) },
      { method: "GET", path: P.final, reply: capturedAnswer("select-pages", 3, values) },
    ]);
    const outcome = await transport.run(statement("SELECT number, to_string(number) AS text FROM numbers(25)"));
    script.expectDone();
    expect(outcome.schema).toEqual([
      { name: "number", type: "UInt64" },
      { name: "text", type: "String" },
    ]);
    expect(outcome.rows).toHaveLength(25);
    expect(outcome.rows[24]).toEqual(["24", "24"]);
    expect(outcome.truncated).toBeNull();
    expect(outcome.hasResultSet).toBe(true);
    // The capture sent no settings, so its echo has no result mode: the floor warning (I6).
    expect(outcome.notices).toEqual([{ kind: "result-mode", mode: "" }]);
  });

  test("the first non-empty schema is kept: a Starting answer has none", async () => {
    const schema = [{ name: "a", type: "Int32" }];
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Starting", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { schema, data: [["1"]], next_uri: P.page(1) }) },
      { method: "GET", path: P.page(1), reply: ok(FIRST, { schema: [], data: [], next_uri: null }) },
    ]);
    const outcome = await transport.run(statement("SELECT 1 AS a"));
    script.expectDone();
    expect(outcome.schema).toEqual(schema);
    expect(outcome.rows).toEqual([["1"]]);
  });

  test("DDL answers no result set; an affect is carried", async () => {
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { has_result_set: false, affect: { type: "UseDB", name: "studio_demo" } }),
      },
    ]);
    const outcome = await transport.run(statement("USE studio_demo"));
    script.expectDone();
    expect(outcome.hasResultSet).toBe(false);
    expect(outcome.affect).toEqual({ type: "UseDB", name: "studio_demo" });
    expect(outcome.notices).toEqual([{ kind: "use-not-carried" }]);
  });

  test("an in-body error closes with one final GET, no kill, and is Databend's statement error", async () => {
    const message = "error: \n  --> SQL:1:15\n  |\n1 | SELECT a FROM ev_temp\n  |               ^^^^^^^ Unknown table";
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { state: "Failed", error: { code: 1025, message }, data: [], next_uri: P.final }),
      },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    const error = await failure(transport.run(statement("SELECT a FROM ev_temp")));
    script.expectDone();
    expect(error.category).toBe("statement");
    expect(error.code).toBe(1025);
    expect(error.position).toBe(15);
  });

  test("an in-body error on an answer with no next link sends nothing more", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Failed", error: { code: 1065, message: "x" } }) },
    ]);
    expect((await failure(transport.run(statement("SELECT")))).code).toBe(1065);
    script.expectDone();
  });
});

describe("every later page, checked as the first answer is (design 3.4)", () => {
  const SCHEMA = [
    { name: "a", type: "Int32" },
    { name: "b", type: "String" },
  ];
  /** A session that would ask for a ROLLBACK and a logout, were the answer that echoed it read as this statement's. */
  const OPEN = { txn_state: "Active", need_keep_alive: true, settings: { http_json_result_mode: "display" } };
  const RUNNING = ok(FIRST, { state: "Running", schema: SCHEMA, data: [["1", "x"]], next_uri: P.page(0) });

  test.each([
    ["another statement", { id: "0".repeat(32) }, F.queryId],
    ["another session", { session_id: "another" }, F.sessionId],
    ["a session Databend made itself", { session_id: "" }, F.proxySession],
  ])("a page for %s is protocol, closed with the statement's own ids", async (_label, fields, fault) => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      {
        method: "GET",
        path: P.page(0),
        reply: ok(FIRST, { schema: SCHEMA, data: [["2", "y"]], session: OPEN, next_uri: P.page(1), ...fields }),
      },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT a, b FROM t")));
    // One kill of our own query id in our own session; the other answer's open session closes nothing.
    script.expectDone();
    expect(error.category).toBe("protocol");
    expect(error.message).toBe(S.protocol(fault));
    expect(script.requests[2].headers["x-databend-session"]).toBe(script.requests[0].headers["x-databend-session"]);
  });

  test.each([
    [
      "its columns in another order",
      [
        { name: "b", type: "String" },
        { name: "a", type: "Int32" },
      ],
      [["y", "2"]],
    ],
    [
      "a column of another type",
      [
        { name: "a", type: "Int64" },
        { name: "b", type: "String" },
      ],
      [["2", "y"]],
    ],
    [
      "a column of another name",
      [
        { name: "a", type: "Int32" },
        { name: "c", type: "String" },
      ],
      [["2", "y"]],
    ],
    ["one column more", [...SCHEMA, { name: "c", type: "String" }], [["2", "y", "z"]]],
    ["rows and no schema", [], [[]]],
  ])("a page with %s is protocol, and none of its rows is kept", async (_label, schema, data) => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { schema, data, next_uri: P.page(1) }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT a, b FROM t")));
    script.expectDone();
    expect(error.category).toBe("protocol");
    expect(error.message).toBe(S.protocol(F.pageSchema));
  });

  test("after a Starting answer with no schema, the first page's schema is the one every later page carries", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Starting", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { schema: SCHEMA, data: [["1", "x"]], next_uri: P.page(1) }) },
      {
        method: "GET",
        path: P.page(1),
        reply: ok(FIRST, { schema: [{ name: "a", type: "Int32" }], data: [["2"]], next_uri: P.page(2) }),
      },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT a, b FROM t")))).message).toBe(S.protocol(F.pageSchema));
    script.expectDone();
  });

  test("a long poll still running, with no schema and no rows, is read as it is, and the next page as well", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: RUNNING },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { schema: SCHEMA, data: [["2", "y"]], next_uri: P.final }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    const outcome = await transport.run(statement("SELECT a, b FROM t"));
    script.expectDone();
    expect(outcome.schema).toEqual(SCHEMA);
    expect(outcome.rows).toEqual([
      ["1", "x"],
      ["2", "y"],
    ]);
  });

  test("every captured later page carries its first answer's query id and schema, in captures taken with no client session", () => {
    const root = join(import.meta.dir, "../../../fixtures/databend");
    interface Captured {
      readonly clientSession: boolean;
      readonly exchanges: readonly {
        readonly request: { readonly method: string; readonly path: string };
        readonly response: { readonly status: number; readonly body: unknown };
      }[];
    }
    interface Answer {
      readonly id: string;
      readonly schema: readonly unknown[];
    }
    let pages = 0;
    for (const run of readdirSync(root).filter((name) => /^(local|cloud)-/.test(name))) {
      for (const file of readdirSync(join(root, run)).filter((name) => name !== "manifest.json")) {
        const { clientSession, exchanges } = JSON.parse(readFileSync(join(root, run, file), "utf8")) as Captured;
        const firsts = new Map<string, Answer>();
        for (const { request, response } of exchanges) {
          const answer = response.body as Answer;
          if (request.method === "POST" && request.path === "/v1/query" && response.status === 200) {
            firsts.set(answer.id, answer);
          }
          const page = /^\/v1\/query\/([^/]+)\/page\/\d+$/.exec(request.path);
          if (page === null || response.status !== 200) continue;
          // Without a client session no answer echoes Studio's, so these pages show nothing of the session rule:
          // section 3.3 names where the echo on a later page was measured.
          expect(clientSession, `${run}/${file}`).toBe(false);
          const first = firsts.get(page[1]) as Answer;
          expect(answer.id, `${run}/${file}`).toBe(first.id);
          if (answer.schema.length > 0) expect(answer.schema, `${run}/${file}`).toEqual(first.schema);
          pages += 1;
        }
      }
    }
    // select-pages of each run: two later pages each.
    expect(pages).toBe(4);
  });
});

describe("the notices", () => {
  test.each([
    ["display", null],
    ["classic", { kind: "result-mode" as const, mode: "classic" }],
  ])("an echoed result mode %s gives %p (I6)", async (mode, notice) => {
    const session = { txn_state: "AutoCommit", settings: { http_json_result_mode: mode } };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session }) },
    ]);
    const outcome = await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(outcome.notices).toEqual(notice === null ? [] : [notice]);
    if (notice !== null) expect(DATABEND_ANSWER_SENTENCES.resultMode(mode)).toContain(mode);
  });

  test("warnings become server warnings through serverText, once each across pages (I18)", async () => {
    const withheld = serverText(TEST_PASSWORD, testOptions().secretForms);
    const { script, transport } = transportHarness([
      {
        method: "POST",
        path: "/v1/query",
        reply: ok(FIRST, { warnings: ["setting no_such_setting ignored"], next_uri: P.page(0) }),
      },
      {
        method: "GET",
        path: P.page(0),
        reply: ok(FIRST, { warnings: ["setting no_such_setting ignored", `role ${TEST_PASSWORD} denied`] }),
      },
    ]);
    const outcome = await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(outcome.notices).toEqual([
      { kind: "server-warning", text: "setting no_such_setting ignored" },
      { kind: "server-warning", text: withheld },
    ]);
  });

  test("the first 100 distinct warnings are kept, and the ones past them only counted, after them (F4)", async () => {
    expect(DATABEND_WARNING_LIMIT).toBe(100);
    const distinct = (from: number) => Array.from({ length: 60 }, (_, n) => `w${from + n}`);
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { warnings: distinct(0), next_uri: P.page(0) }) },
      // w0 again is one of the kept ones: neither kept twice nor counted.
      { method: "GET", path: P.page(0), reply: ok(FIRST, { warnings: [...distinct(60), "w0"], next_uri: P.page(1) }) },
      // w130 twice: each one Databend sent past the kept ones is counted.
      { method: "GET", path: P.page(1), reply: ok(FIRST, { warnings: [...distinct(120), "w130"] }) },
    ]);
    const outcome = await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(outcome.notices).toEqual([
      ...Array.from({ length: 100 }, (_, n) => ({ kind: "server-warning" as const, text: `w${n}` })),
      { kind: "warnings-left-out", count: 20 + 61 },
    ]);
  });

  test("many pages of distinct warnings keep 100 of them, however many Databend sends (F4)", async () => {
    const pages = 50;
    const perPage = 1000;
    const warnings = (page: number) => Array.from({ length: perPage }, (_, n) => `page ${page} warning ${n}`);
    const next = (page: number) => (page + 1 < pages ? { next_uri: P.page(page) } : {});
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { warnings: warnings(0), ...next(0) }) },
      ...Array.from({ length: pages - 1 }, (_, n) => ({
        method: "GET" as const,
        path: P.page(n),
        reply: ok(FIRST, { warnings: warnings(n + 1), ...next(n + 1) }),
      })),
    ]);
    const outcome = await transport.run(statement("SELECT 1"));
    script.expectDone();
    expect(outcome.notices).toHaveLength(DATABEND_WARNING_LIMIT + 1);
    expect(outcome.notices.at(-1)).toEqual({ kind: "warnings-left-out", count: pages * perPage - 100 });
  });

  test("SET ROLE is told against the role the first provider statement echoed (design 3.7)", async () => {
    const role = (name: string) => ({
      session: { txn_state: "AutoCommit", role: name, settings: { http_json_result_mode: "display" } },
    });
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(idsOf(1), role("analyst")) },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(2), role("public")) },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(3), role("analyst")) },
      { method: "POST", path: "/v1/query", reply: ok(idsOf(4), role("public")) },
    ]);
    // A user statement before the probe has nothing to compare with.
    expect((await transport.run(statement("SET ROLE analyst"))).notices).toEqual([]);
    expect((await transport.run(statement("SELECT 1", { origin: "provider" }))).notices).toEqual([]);
    expect((await transport.run(statement("SET ROLE analyst"))).notices).toEqual([{ kind: "role-not-carried" }]);
    expect((await transport.run(statement("SELECT 1"))).notices).toEqual([]);
    script.expectDone();
  });

  test("SET and SET GLOBAL give their warnings from the affect", async () => {
    const affect = { type: "ChangeSettings", keys: ["a", "b"], values: ["1", "2"], is_globals: [false, true] };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { affect }) },
    ]);
    expect((await transport.run(statement("SET a = 1"))).notices).toEqual([
      { kind: "settings-not-carried" },
      { kind: "global-settings-changed", keys: ["b"] },
    ]);
    script.expectDone();
  });
});

test("a captured answer's body is the capture's text with its placeholders replaced", () => {
  const reply = capturedAnswer("auth-401", 0, {});
  expect(reply.status).toBe(401);
  expect(JSON.parse(reply.body)).toEqual({
    error: { code: 5100, message: "Authentication failed: incorrect password" },
  });
  expect(answerBody({}).next_uri).toBeNull();
});

describe("the statement request's paging and settings", () => {
  test("a page holds 10,000 rows or the row cut plus one, the buffer two pages, and seven settings are sent", async () => {
    const ids = idsOf(1);
    const harness = transportHarness([{ method: "POST", path: QUERY_PATH, reply: ok(ids) }]);
    await harness.transport.run(statement("SELECT 1", { origin: "provider", rowCut: MAX_UNLIMITED_ROWS }));
    const [sent] = harness.script.requests;
    const body = JSON.parse(sent.body ?? "{}") as {
      session: { settings: Record<string, string> };
      pagination: { wait_time_secs: number; max_rows_per_page: number; max_rows_in_buffer: number };
    };
    expect(body.pagination.max_rows_per_page).toBe(10_000);
    expect(body.pagination.max_rows_in_buffer).toBe(2 * body.pagination.max_rows_per_page);
    const small = transportHarness([{ method: "POST", path: QUERY_PATH, reply: ok(ids) }]);
    await small.transport.run(statement("SELECT 1", { origin: "provider", rowCut: 99 }));
    const smallBody = JSON.parse(small.script.requests[0].body ?? "{}") as typeof body;
    expect(smallBody.pagination.max_rows_per_page).toBe(99 + 1);
    expect(smallBody.pagination.max_rows_in_buffer).toBe(2 * (99 + 1));
    const settings = Object.keys(body.session.settings);
    expect(settings).toHaveLength(7);
  });
});
