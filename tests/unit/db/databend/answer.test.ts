/**
 * Reading one HTTP answer of Databend's query API (design 3.12, section 4; I6): only a 200 `application/json` body is
 * an answer, anything else is a refusal read by status, then content type; an answer that does not have the measured
 * shape is `protocol`. What one answer may hold is bounded before it is parsed: its rows by the page Studio asked
 * for, its columns by the cell budget, everything else by a fixed allowance, and a refusal is read up to 64 KiB.
 */
import { describe, expect, test } from "bun:test";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import {
  type AnswerBounds,
  type DatabendAnswer,
  DATABEND_ANSWER_SENTENCES,
  RESULT_MODE_FLOOR,
  readAnswer,
  readCloseAnswer,
  resultModeNotice,
} from "@/lib/db/providers/sql/databend/answer";
import {
  DATABEND_ERROR_SENTENCES,
  DATABEND_PROTOCOL_FAULTS,
  refusalError,
} from "@/lib/db/providers/sql/databend/errors";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import { secretForms, serverText } from "@/lib/db/utils/server-text";

function response(status: number, contentType: string | null, text: string): NodeResponse {
  return { status, contentType, retryAfter: null, text };
}

const json = (body: unknown, status = 200) => response(status, "application/json", JSON.stringify(body));

/** The bounds of a statement that asked for a full page, under the connection's cell budget. */
const BOUNDS: AnswerBounds = { rows: 10_000, columns: 250_000 };
/** The arrays, objects, keys and values an answer may hold outside its rows and columns. */
const ALLOWANCE = 65_536;
/** How deep an answer may nest arrays and objects, its own object included: a real one nests 3. */
const ANSWER_DEPTH = 64;
/** The characters of a refusal that are read. */
const REFUSAL_CHARS = 64 * 1024;

/** A first answer as the pinned image sends it (07 M12, M08). */
const FIRST = {
  id: "01a116fd3e5d7640bc61a15733696db0",
  session_id: "5e7f0c55-0000-4000-8000-000000000001",
  node_id: "BvtSyQG274L1gg2XccJC52",
  state: "Succeeded",
  session: {
    catalog: "default",
    database: "default",
    role: "account_admin",
    settings: { http_json_result_mode: "display", timezone: "UTC" },
    txn_state: "AutoCommit",
    need_sticky: false,
    need_keep_alive: false,
    internal: '{"last_node_id":"BvtSyQG274L1gg2XccJC52"}',
  },
  error: null,
  warnings: ["setting foo is ignored"],
  has_result_set: true,
  schema: [
    { name: "a", type: "Nullable(Int64)" },
    { name: "b", type: "String" },
  ],
  data: [
    ["1", "x"],
    [null, "y"],
  ],
  affect: null,
  result_timeout_secs: 60,
  stats_uri: "/v1/query/01a116fd3e5d7640bc61a15733696db0",
  final_uri: "/v1/query/01a116fd3e5d7640bc61a15733696db0/final",
  next_uri: "/v1/query/01a116fd3e5d7640bc61a15733696db0/page/1",
  kill_uri: "/v1/query/01a116fd3e5d7640bc61a15733696db0/kill",
};

function answerOf(body: unknown): DatabendAnswer {
  const reading = readAnswer(json(body), BOUNDS);
  if (reading.kind !== "answer") throw new Error("expected an answer");
  return reading.answer;
}

function protocolOf(run: () => unknown): DatabendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabendError);
    expect((error as DatabendError).category).toBe("protocol");
    return error as DatabendError;
  }
  throw new Error("expected a protocol error");
}

describe("a 200 JSON answer", () => {
  test("becomes the typed answer", () => {
    const answer = answerOf(FIRST);
    expect(answer).toEqual({
      id: FIRST.id,
      sessionId: FIRST.session_id,
      nodeId: FIRST.node_id,
      state: "Succeeded",
      error: null,
      warnings: ["setting foo is ignored"],
      hasResultSet: true,
      schema: [
        { name: "a", type: "Nullable(Int64)" },
        { name: "b", type: "String" },
      ],
      data: [
        ["1", "x"],
        [null, "y"],
      ],
      nextUri: FIRST.next_uri,
      affect: null,
      session: {
        raw: FIRST.session,
        txnState: "AutoCommit",
        needKeepAlive: false,
        role: "account_admin",
        settings: { http_json_result_mode: "display", timezone: "UTC" },
      },
    });
  });

  test("accepts a charset parameter on the content type", () => {
    const reading = readAnswer(response(200, "application/json; charset=utf-8", JSON.stringify(FIRST)), BOUNDS);
    expect(reading.kind).toBe("answer");
  });

  test("a final answer: no session, no next link, no rows; has_result_set absent reads the schema", () => {
    const answer = answerOf({ id: "q", state: "Succeeded", schema: [{ name: "a", type: "UInt8" }], session: null });
    expect(answer.session).toBeNull();
    expect(answer.nextUri).toBeNull();
    expect(answer.nodeId).toBeNull();
    expect(answer.sessionId).toBeNull();
    expect(answer.data).toEqual([]);
    expect(answer.warnings).toEqual([]);
    expect(answer.hasResultSet).toBe(true);
    expect(answerOf({ id: "q", state: "Succeeded" }).hasResultSet).toBe(false);
  });

  test("a session with only some fields reads the rest as absent", () => {
    const answer = answerOf({ id: "q", state: "Running", session: { need_sticky: false } });
    expect(answer.session).toEqual({
      raw: { need_sticky: false },
      txnState: null,
      needKeepAlive: false,
      role: null,
      settings: {},
    });
  });

  test("an in-body error is read with its code, message and detail", () => {
    const answer = answerOf({
      id: "",
      state: "Failed",
      error: { code: 2803, message: "Value bogus is not within the allowed values" },
      next_uri: null,
    });
    expect(answer.error).toEqual({ code: 2803, message: "Value bogus is not within the allowed values", detail: null });
    const detailed = answerOf({ id: "q", state: "Failed", error: { code: 1046, message: "m", detail: "d" } });
    expect(detailed.error).toEqual({ code: 1046, message: "m", detail: "d" });
  });

  test("the affect of USE and SET is read; any other type is not carried", () => {
    expect(answerOf({ ...FIRST, affect: { type: "UseDB", name: "probe" } }).affect).toEqual({
      type: "UseDB",
      name: "probe",
    });
    expect(answerOf({ ...FIRST, affect: { type: "UseCatalog", name: "c" } }).affect).toEqual({
      type: "UseCatalog",
      name: "c",
    });
    expect(
      answerOf({
        ...FIRST,
        affect: { type: "ChangeSettings", keys: ["max_threads"], values: ["4"], is_globals: [true] },
      }).affect,
    ).toEqual({ type: "ChangeSettings", keys: ["max_threads"], values: ["4"], isGlobals: [true] });
    expect(
      answerOf({ ...FIRST, affect: { type: "Create", kind: "table", name: "t", success: true } }).affect,
    ).toBeNull();
  });

  test("a 200 gateway body is a refusal", () => {
    expect(
      readAnswer(json({ kind: "ProvisionWarehouseTimeout", message: "provision warehouse timeout" }), BOUNDS),
    ).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "ProvisionWarehouseTimeout",
        text: "provision warehouse timeout",
      },
    });
  });
});

describe("anything but a 200 JSON body", () => {
  test("a 200 of another content type is protocol", () => {
    const error = protocolOf(() => readAnswer(response(200, "text/plain", "ok"), BOUNDS));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.notAnswer));
    expect(error.status).toBe(200);
    protocolOf(() => readAnswer(response(200, null, "{}"), BOUNDS));
  });

  test("a non-200 text body is a refusal read by its status, with the body as its text", () => {
    expect(readAnswer(response(500, "text/plain", "[HTTP-PANIC] Internal server error"), BOUNDS)).toEqual({
      kind: "refusal",
      refusal: {
        status: 500,
        contentType: "text/plain",
        code: null,
        gatewayKind: null,
        text: "[HTTP-PANIC] Internal server error",
      },
    });
  });

  test("a non-200 JSON body gives its code and message", () => {
    const reading = readAnswer(
      json({ error: { code: 5100, message: "Authentication failed: incorrect password" } }, 401),
      BOUNDS,
    );
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 401,
        contentType: "application/json",
        code: 5100,
        gatewayKind: null,
        text: "Authentication failed: incorrect password",
      },
    });
  });

  test("a gateway body gives its kind and message", () => {
    const reading = readAnswer(json({ kind: "WarehouseNotFound", message: "warehouse not found" }, 404), BOUNDS);
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 404,
        contentType: "application/json",
        code: null,
        gatewayKind: "WarehouseNotFound",
        text: "warehouse not found",
      },
    });
  });

  test("databend-go's string error shape gives its message, else the error string", () => {
    const withMessage = readAnswer(json({ error: "Unauthorized", message: "bad token" }, 401), BOUNDS);
    expect(withMessage.kind === "refusal" && withMessage.refusal.text).toBe("bad token");
    const bare = readAnswer(json({ error: "Unauthorized" }, 401), BOUNDS);
    expect(bare.kind === "refusal" && bare.refusal.text).toBe("Unauthorized");
  });

  test("a non-200 JSON body that does not parse, or names nothing, keeps the raw text", () => {
    const broken = readAnswer(response(502, "application/json", "<html>bad gateway</html>"), BOUNDS);
    expect(broken).toEqual({
      kind: "refusal",
      refusal: {
        status: 502,
        contentType: "application/json",
        code: null,
        gatewayKind: null,
        text: "<html>bad gateway</html>",
      },
    });
    const empty = readAnswer(response(503, "application/json", "[]"), BOUNDS);
    expect(empty.kind === "refusal" && empty.refusal.text).toBe("[]");
  });

  test("a message-less JSON body that echoes the password escaped is withheld, not shown escaped", () => {
    const cases: readonly [string, string][] = [
      ['pa"ss\\w', JSON.stringify({ detail: 'bad credential pa"ss\\w' })],
      ["a/b/c9", '{"detail":"Basic auth reader:a\\/b\\/c9 refused"}'],
      ["Müller1", '{"detail":"login failed for reader with password M\\u00fcller1"}'],
    ];
    for (const [password, body] of cases) {
      const forms = secretForms([password, `reader:${password}`]);
      const reading = readAnswer(response(502, "application/json", body), BOUNDS);
      if (reading.kind !== "refusal") throw new Error("expected a refusal");
      const ctx = {
        request: "get",
        origin: "user",
        sql: "SELECT 1",
        endpoint: { host: "h", port: 8000 },
        timeoutMs: 1000,
        secretForms: forms,
      } as const;
      expect(refusalError(reading.refusal, ctx).message).toBe(
        DATABEND_ERROR_SENTENCES.server(502, serverText(password, forms)),
      );
    }
  });
});

describe("protocol", () => {
  test("a 200 JSON body that does not parse", () => {
    const error = protocolOf(() => readAnswer(response(200, "application/json", "{"), BOUNDS));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.notJson));
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test("nesting deeper than an answer may have is refused before it is parsed, as its own fault (REV-T-1)", () => {
    const deep = `{"id":"q","state":"Running","x":${"[".repeat(200_000)}${"]".repeat(200_000)}}`;
    const error = protocolOf(() => readAnswer(response(200, "application/json", deep), BOUNDS));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.depth));
    expect(error.cause).toBeUndefined();
  });

  test("64 arrays and objects deep, the answer's own object included, is read; one more is refused", () => {
    const nested = (arrays: number) =>
      response(200, "application/json", `{"id":"q","state":"Running","x":${"[".repeat(arrays)}${"]".repeat(arrays)}}`);
    expect(readAnswer(nested(ANSWER_DEPTH - 1), BOUNDS).kind).toBe("answer");
    expect(protocolOf(() => readAnswer(nested(ANSWER_DEPTH), BOUNDS)).message).toBe(
      DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.depth),
    );
    // Brackets inside a string are text, at any count.
    const text = response(200, "application/json", `{"id":"q","state":"Running","x":"${"[".repeat(1000)}"}`);
    expect(readAnswer(text, BOUNDS).kind).toBe("answer");
  });

  test("__proto__ as a key, anywhere, however it is spelled", () => {
    for (const text of [
      '{"__proto__":{"polluted":true},"id":"q","state":"Running"}',
      '{"id":"q","state":"Running","session":{"settings":{"__proto__":"x"}}}',
      '{"id":"q","state":"Running","x":[[{"\\u005f_proto__":1}]]}',
      '{"id":"q","state":"Running","schema":[{"name":"a","type":"String","__proto__":"x"}]}',
    ]) {
      const error = protocolOf(() => readAnswer(response(200, "application/json", text), BOUNDS));
      expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.prototypeKey));
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a numeric cell", () => {
    const error = protocolOf(() => answerOf({ ...FIRST, data: [[1, "x"]] }));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.cell));
  });

  test("a row that is not an array", () => {
    const error = protocolOf(() => answerOf({ ...FIRST, data: ["1"] }));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.cell));
  });

  test("a row of the wrong width", () => {
    const error = protocolOf(() => answerOf({ ...FIRST, data: [["1"]] }));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.width(1, 2)));
    expect(DATABEND_PROTOCOL_FAULTS.width(1, 2)).toBe("a row of 1 cells for 2 columns");
  });

  test("a body that is not an object", () => {
    const error = protocolOf(() => readAnswer(json([1]), BOUNDS));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.field("answer")));
    protocolOf(() => readAnswer(json(null), BOUNDS));
  });

  test("a field of the wrong type", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["id", { id: 1 }],
      ["state", { state: null }],
      ["node_id", { node_id: 7 }],
      ["has_result_set", { has_result_set: "yes" }],
      ["schema", { schema: {} }],
      ["schema", { schema: [{ name: "a" }] }],
      ["schema", { schema: [null] }],
      ["data", { data: "rows" }],
      ["error", { error: "bad" }],
      ["error", { error: { code: "1005", message: "m" } }],
      ["error", { error: { code: 1005, message: "m", detail: 3 } }],
      ["warnings", { warnings: [1] }],
      ["session", { session: [] }],
      ["session", { session: { txn_state: 1 } }],
      ["session", { session: { need_keep_alive: "no" } }],
      ["session", { session: { settings: { a: 1 } } }],
      ["session", { session: { settings: "x" } }],
      ["affect", { affect: { type: "UseDB" } }],
      ["affect", { affect: { type: "ChangeSettings", keys: ["a"], values: ["1"], is_globals: ["yes"] } }],
      ["affect", { affect: { type: "ChangeSettings", keys: ["a"], values: [1], is_globals: [true] } }],
      ["affect", { affect: "UseDB" }],
    ];
    for (const [field, patch] of cases) {
      const error = protocolOf(() => answerOf({ ...FIRST, ...patch }));
      expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.field(field)));
    }
  });
});

describe("what one answer may hold, counted before it is parsed (design 3.12; HASIM-D-2)", () => {
  const SMALL: AnswerBounds = { rows: 2, columns: 3 };
  const schema = [{ name: "a", type: "String" }];
  const row = (value: string) => `[${JSON.stringify(value)}]`;
  const body = (fields: string) => `{"id":"q","state":"Running","schema":${JSON.stringify(schema)},${fields}}`;
  const read = (text: string, bounds = SMALL) => readAnswer(response(200, "application/json", text), bounds);
  const fault = (what: string) => DATABEND_ERROR_SENTENCES.protocol(what);

  test("data of the page's rows is read; one row more is refused, before a body that does not parse is", () => {
    const reading = read(body(`"data":[${row("1")},${row("2")}]`));
    expect(reading.kind === "answer" && reading.answer.data).toEqual([["1"], ["2"]]);
    expect(protocolOf(() => read(body(`"data":[${row("1")},${row("2")},${row("3")}]`))).message).toBe(
      fault(DATABEND_PROTOCOL_FAULTS.rows),
    );
    // The third row is counted before the text is parsed: the body never closes.
    expect(protocolOf(() => read(`{"id":"q","state":"Running","data":[[],[],[`)).message).toBe(
      fault(DATABEND_PROTOCOL_FAULTS.rows),
    );
  });

  test("data under a key spelled with an escape is held to the page once it is parsed", () => {
    const text = body(`"d\\u0061ta":[${row("1")},${row("2")},${row("3")}]`);
    expect(protocolOf(() => read(text)).message).toBe(fault(DATABEND_PROTOCOL_FAULTS.rows));
  });

  test("a schema wider than the columns a result can keep, or a column of more keys, is refused before parsing", () => {
    const columns = (count: number) => Array.from({ length: count }, (_, n) => ({ name: `c${n}`, type: "String" }));
    const wide = `{"id":"q","state":"Running","schema":${JSON.stringify(columns(4))}`;
    expect(protocolOf(() => read(wide)).message).toBe(fault(DATABEND_PROTOCOL_FAULTS.schema));
    const keyed = `{"id":"q","state":"Running","schema":[{"name":"a","type":"S","b":1,"c":2,"d":3,"e":4,"f":5,"g":6}`;
    expect(protocolOf(() => read(keyed, { rows: 2, columns: 1 })).message).toBe(fault(DATABEND_PROTOCOL_FAULTS.schema));
    const reading = read(body(`"data":[]`).replace(JSON.stringify(schema), JSON.stringify(columns(3))));
    expect(reading.kind === "answer" && reading.answer.schema).toHaveLength(3);
  });

  test("a row's cells are held by the answer's bytes alone: a page wider than the allowance is read whole", () => {
    const width = ALLOWANCE + 10;
    const wide = Array.from({ length: width }, (_, n) => ({ name: `c${n}`, type: "String" }));
    const cells = JSON.stringify(Array.from({ length: width }, () => null));
    const reading = read(`{"id":"q","state":"Running","schema":${JSON.stringify(wide)},"data":[${cells}]}`, BOUNDS);
    expect(reading.kind === "answer" && reading.answer.data[0]).toHaveLength(width);
  });

  test.each([
    ["values in an array of the answer", `"x":[${"0,".repeat(ALLOWANCE)}0]`],
    ["keys of an object of the answer", `"x":{${Array.from({ length: ALLOWANCE }, (_, n) => `"k${n}":0`).join(",")}}`],
    ["arrays inside a row", `"data":[[${"[],".repeat(ALLOWANCE)}[]]]`],
    ["values inside a column", `"schema":[{"name":[${"0,".repeat(ALLOWANCE)}0]}]`],
  ])("more %s than the allowance are refused before parsing, as an answer holding too much", (_label, fields) => {
    expect(protocolOf(() => read(`{"id":"q","state":"Running",${fields}}`, BOUNDS)).message).toBe(
      fault(DATABEND_PROTOCOL_FAULTS.values),
    );
  });

  test("a bound passed reads as too large, never as a field of the wrong type (REV-T-3)", () => {
    for (const what of [
      DATABEND_PROTOCOL_FAULTS.rows,
      DATABEND_PROTOCOL_FAULTS.schema,
      DATABEND_PROTOCOL_FAULTS.values,
      DATABEND_PROTOCOL_FAULTS.depth,
    ]) {
      expect(what).not.toContain("wrong type");
    }
    expect(DATABEND_PROTOCOL_FAULTS.rows).toBe("more rows than the page Studio asked for");
    expect(DATABEND_PROTOCOL_FAULTS.schema).toBe("a schema larger than a result can keep");
    expect(DATABEND_PROTOCOL_FAULTS.values).toBe("more values than one answer may hold");
    expect(DATABEND_PROTOCOL_FAULTS.depth).toBe("nesting deeper than one answer may have");
  });

  test("the allowance counts only outside strings: brackets, commas and colons inside one are text", () => {
    const text = `[{"a":1},`.repeat(ALLOWANCE);
    const reading = read(body(`"data":[${row(text)}]`));
    expect(reading.kind === "answer" && reading.answer.data).toEqual([[text]]);
    const escaped = read(body(`"data":[${row(`\\"${text}`)}]`));
    expect(escaped.kind === "answer" && escaped.answer.data[0][0]).toBe(`\\"${text}`);
  });

  test("an answer just inside the allowance is parsed", () => {
    const reading = read(`{"id":"q","state":"Running","x":[${"0,".repeat(ALLOWANCE - 64)}0]}`, BOUNDS);
    expect(reading.kind).toBe("answer");
  });
});

describe("a refusal is read up to 64 KiB (HASIM-D-2)", () => {
  test("a longer one is read by its status alone, never parsed, its text cut", () => {
    const text = JSON.stringify({
      error: { code: 5100, message: "Authentication failed" },
      pad: "x".repeat(REFUSAL_CHARS),
    });
    expect(readAnswer(response(401, "application/json", text), BOUNDS)).toEqual({
      kind: "refusal",
      refusal: {
        status: 401,
        contentType: "application/json",
        code: null,
        gatewayKind: null,
        text: text.slice(0, REFUSAL_CHARS),
      },
    });
  });

  test("one of exactly 64 KiB is parsed", () => {
    const head = '{"error":{"code":5100,"message":"Authentication failed"},"pad":"';
    const text = `${head}${"x".repeat(REFUSAL_CHARS - head.length - 2)}"}`;
    expect(text).toHaveLength(REFUSAL_CHARS);
    const reading = readAnswer(response(401, "application/json", text), BOUNDS);
    expect(reading.kind === "refusal" && reading.refusal.code).toBe(5100);
  });

  test("a message longer than 64 KiB is cut before it is read for a wrapper or shown", () => {
    const message = `status: 401, message: {"error":{"code":5100,"message":"x"}}: ${"w".repeat(REFUSAL_CHARS)}`;
    const reading = readAnswer(json({ error: { kind: "AuthorizationFailed", message } }), BOUNDS);
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "AuthorizationFailed",
        text: message.slice(0, REFUSAL_CHARS),
        upstreamStatus: 401,
        upstreamCode: 5100,
        upstreamMessage: "x",
      },
    });
  });

  test("a gateway refusal over HTTP 200 is read from the parse its answer already had, whatever its length", () => {
    const reading = readAnswer(
      json({ error: { kind: "ProvisionWarehouseTimeout", message: "resuming" }, pad: "x".repeat(REFUSAL_CHARS) }),
      BOUNDS,
    );
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "ProvisionWarehouseTimeout",
        text: "resuming",
      },
    });
  });

  test("a long message-less gateway refusal over HTTP 200 is not walked for its strings", () => {
    const text = JSON.stringify({ kind: "Unexpected", pad: "x".repeat(REFUSAL_CHARS) });
    const reading = readAnswer(response(200, "application/json", text), BOUNDS);
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "Unexpected",
        text: text.slice(0, REFUSAL_CHARS),
      },
    });
  });
});

describe("a close's 200, read only for a gateway's refusal (REV-T-2)", () => {
  test("what a kill, a final and a logout answer acknowledges the close", () => {
    // kill.json: 200 with no content type and an empty body; the logout's and a final's, as captured.
    expect(readCloseAnswer(response(200, null, ""))).toBeNull();
    expect(readCloseAnswer(response(200, "application/json; charset=utf-8", '{"error":null}'))).toBeNull();
    expect(readCloseAnswer(json({ ...FIRST, next_uri: null }))).toBeNull();
    // A close is read by its status: an empty or broken JSON body is no fault here.
    expect(readCloseAnswer(response(200, "application/json", ""))).toBeNull();
    expect(readCloseAnswer(response(200, "application/json", "{"))).toBeNull();
    expect(readCloseAnswer(json([1]))).toBeNull();
    // A kind beside a state is an answer's field, not a refusal.
    expect(readCloseAnswer(json({ id: "q", state: "Succeeded", kind: "AuthorizationFailed" }))).toBeNull();
  });

  test("a gateway's refusal over HTTP 200, its kind nested or top-level, is a refusal with its upstream", () => {
    const wrapped = `status: 401, message: {"error":{"code":5100,"message":"Authentication failed"}}: Authorization failed`;
    expect(readCloseAnswer(json({ error: { kind: "AuthorizationFailed", message: wrapped } }))).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "AuthorizationFailed",
        text: wrapped,
        upstreamStatus: 401,
        upstreamCode: 5100,
        upstreamMessage: "Authentication failed",
      },
    });
    expect(readCloseAnswer(json({ kind: "ProvisionWarehouseTimeout", message: "resuming" }))).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "ProvisionWarehouseTimeout",
        text: "resuming",
      },
    });
  });

  test("a body longer than 64 KiB is never parsed: the close is read by its status", () => {
    const padded = json({ error: { kind: "AuthorizationFailed", message: "no" }, pad: "x".repeat(REFUSAL_CHARS) });
    expect(readCloseAnswer(padded)).toBeNull();
  });
});

describe("the result-mode echo (design section 4, I6)", () => {
  test("display gives no notice", () => {
    expect(resultModeNotice(answerOf(FIRST))).toBeNull();
  });

  test("another mode gives its notice", () => {
    const answer = answerOf({
      ...FIRST,
      session: { ...FIRST.session, settings: { http_json_result_mode: "driver" } },
    });
    expect(resultModeNotice(answer)).toEqual({ kind: "result-mode", mode: "driver" });
  });

  test("no echo, as below the version floor, gives the notice with an empty mode", () => {
    expect(resultModeNotice(answerOf({ ...FIRST, session: { ...FIRST.session, settings: {} } }))).toEqual({
      kind: "result-mode",
      mode: "",
    });
    expect(resultModeNotice(answerOf({ ...FIRST, session: null }))).toEqual({ kind: "result-mode", mode: "" });
  });

  test("the warning names the mode, or the floor when nothing was echoed", () => {
    expect(RESULT_MODE_FLOOR).toBe("v1.2.881");
    expect(DATABEND_ANSWER_SENTENCES.resultMode("driver")).toBe(
      'Databend answered in the result mode "driver", not "display", so Studio may show some values differently from how Databend displays them.',
    );
    expect(DATABEND_ANSWER_SENTENCES.resultMode("")).toBe(
      "Databend did not confirm the display result mode, which servers older than v1.2.881 do not have, so Studio may show some values differently from how Databend displays them. Upgrade the server to v1.2.881 or later.",
    );
  });
});

/** The Cloud gateway's refusals as measured on a test tenant (I19, C4), host and tenant replaced. */
const CLOUD = {
  wrongPassword: [
    401,
    String.raw`{"error":{"kind":"AuthorizationFailed","message":"status: 401, message: {\"error\":{\"code\":5100,\"message\":\"Authentication failed: incorrect password\"}}: Authorization failed"}}`,
  ],
  unknownUser: [
    401,
    String.raw`{"error":{"kind":"AuthorizationFailed","message":"status: 401, message: {\"error\":{\"code\":2201,\"message\":\"User 'no_such_user_libredb'@'%' does not exist.\"}}: Authorization failed"}}`,
  ],
  lockout: [
    500,
    String.raw`{"error":{"kind":"Unexpected","message":"status: 500, message: {\"error\":{\"code\":2215,\"message\":\"Disable login before 2026-10-08 00:54:35.574391755 UTC because of too many password fails\"}}: Unexpected"}}`,
  ],
  noAuthorization: [
    401,
    `{"error":{"kind":"AuthorizationRequired","message":"no Password or Authorization provided: Authorization is required"}}`,
  ],
  noWarehouse: [400, `{"error":{"kind":"WarehouseHeaderRequired","message":"X-DATABEND-WAREHOUSE is required"}}`],
  badWarehouse: [
    400,
    `{"error":{"kind":"BadWarehouse","message":"warehouse <tenant> no_such_wh_a72e8a not found: Bad warehouse"}}`,
  ],
  forbidden: [403, `{"error":{"kind":"ForbiddenAccessUser","message":"Permission denied"}}`],
} as const satisfies Record<string, readonly [number, string]>;

function cloudRefusal(name: keyof typeof CLOUD) {
  const [status, body] = CLOUD[name];
  const reading = readAnswer(response(status, "application/json", body), BOUNDS);
  if (reading.kind !== "refusal") throw new Error("expected a refusal");
  return reading.refusal;
}

describe("the Databend Cloud gateway's envelope (I19, C4)", () => {
  test("a wrapped upstream refusal gives the nested kind, the upstream status, code and message", () => {
    expect(cloudRefusal("wrongPassword")).toEqual({
      status: 401,
      contentType: "application/json",
      code: null,
      gatewayKind: "AuthorizationFailed",
      text: 'status: 401, message: {"error":{"code":5100,"message":"Authentication failed: incorrect password"}}: Authorization failed',
      upstreamStatus: 401,
      upstreamCode: 5100,
      upstreamMessage: "Authentication failed: incorrect password",
    });
    expect(cloudRefusal("unknownUser")).toMatchObject({
      gatewayKind: "AuthorizationFailed",
      upstreamStatus: 401,
      upstreamCode: 2201,
      upstreamMessage: "User 'no_such_user_libredb'@'%' does not exist.",
    });
    expect(cloudRefusal("lockout")).toMatchObject({
      status: 500,
      gatewayKind: "Unexpected",
      upstreamStatus: 500,
      upstreamCode: 2215,
      upstreamMessage: "Disable login before 2026-10-08 00:54:35.574391755 UTC because of too many password fails",
    });
  });

  test("an unwrapped gateway refusal gives the nested kind and its text, with no upstream fields", () => {
    for (const [name, kind, text] of [
      ["noAuthorization", "AuthorizationRequired", "no Password or Authorization provided: Authorization is required"],
      ["noWarehouse", "WarehouseHeaderRequired", "X-DATABEND-WAREHOUSE is required"],
      ["badWarehouse", "BadWarehouse", "warehouse <tenant> no_such_wh_a72e8a not found: Bad warehouse"],
      ["forbidden", "ForbiddenAccessUser", "Permission denied"],
    ] as const) {
      const refusal = cloudRefusal(name);
      expect(refusal).toEqual({
        status: CLOUD[name][0],
        contentType: "application/json",
        code: null,
        gatewayKind: kind,
        text,
      });
      expect(refusal.upstreamCode).toBeUndefined();
    }
  });

  test("a 200 whose body nests a kind and has no state is a refusal", () => {
    expect(readAnswer(json({ error: { kind: "ProvisionWarehouseTimeout", message: "resuming" } }), BOUNDS)).toEqual({
      kind: "refusal",
      refusal: {
        status: 200,
        contentType: "application/json",
        code: null,
        gatewayKind: "ProvisionWarehouseTimeout",
        text: "resuming",
      },
    });
  });

  test("a 200 whose error has a code and no state is still protocol, not a refusal", () => {
    const error = protocolOf(() => readAnswer(json({ id: "q", error: { code: 1005, message: "bad" } }), BOUNDS));
    expect(error.message).toBe(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.field("state")));
  });

  test.each([
    ["no JSON after message:", "status: 401, message: not json: Authorization failed"],
    ["a brace that never closes", 'status: 401, message: {"error":{"code":5100,: Authorization failed'],
    ["JSON that does not parse", 'status: 401, message: {"error":{"code":5100,}}: Authorization failed'],
    ["a __proto__ key", 'status: 401, message: {"__proto__":{"code":5100,"message":"x"}}: Authorization failed'],
    ["no error object", 'status: 401, message: {"code":5100,"message":"x"}: Authorization failed'],
    [
      "a code that is not a number",
      'status: 401, message: {"error":{"code":"5100","message":"x"}}: Authorization failed',
    ],
    ["a message that is not text", 'status: 401, message: {"error":{"code":5100,"message":7}}: Authorization failed'],
    ["no words after the JSON", 'status: 401, message: {"error":{"code":5100,"message":"x"}}'],
    ["a status of other than three digits", 'status: 4010, message: {"error":{"code":5100,"message":"x"}}: words'],
    ["text before the wrapper", 'proxy said status: 401, message: {"error":{"code":5100,"message":"x"}}: words'],
  ])("a message with %s stays plain text with no upstream fields", (_label, message) => {
    const reading = readAnswer(json({ error: { kind: "AuthorizationFailed", message } }, 401), BOUNDS);
    expect(reading).toEqual({
      kind: "refusal",
      refusal: {
        status: 401,
        contentType: "application/json",
        code: null,
        gatewayKind: "AuthorizationFailed",
        text: message,
      },
    });
    if (reading.kind === "refusal") expect(reading.refusal.upstreamStatus).toBeUndefined();
  });

  test("each measured envelope reaches its row of the error table", () => {
    const ctx = {
      request: "post",
      origin: "user",
      sql: "SHOW WAREHOUSES",
      warehouse: "default",
      endpoint: { host: "h", port: 443 },
      timeoutMs: 1000,
      secretForms: secretForms(["pw", "cloudapp:pw"]),
    } as const;
    const S = DATABEND_ERROR_SENTENCES;
    const cases: readonly [keyof typeof CLOUD, string, string][] = [
      ["wrongPassword", "auth", `${S.signInRefused} Authentication failed: incorrect password. ${S.cloudSqlUser}`],
      ["unknownUser", "auth", `${S.signInRefused} User 'no_such_user_libredb'@'%' does not exist. ${S.cloudSqlUser}`],
      [
        "lockout",
        "auth",
        `${S.signInRefused} Disable login before 2026-10-08 00:54:35.574391755 UTC because of too many password fails. ${S.possibleLockout} ${S.cloudSqlUser}`,
      ],
      ["noAuthorization", "config", S.signInMissing],
      ["noWarehouse", "config", S.warehouseRefused("default")],
      ["badWarehouse", "config", S.warehouseRefused("default")],
      ["forbidden", "statement", S.statementForbidden("Permission denied")],
    ];
    for (const [name, category, message] of cases) {
      const error = refusalError(cloudRefusal(name), ctx);
      expect([name, error.category, error.message]).toEqual([name, category, message]);
    }
  });
});
