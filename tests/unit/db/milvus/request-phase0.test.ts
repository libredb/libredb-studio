/**
 * Phase 0 of the Milvus console request (vector-family spec 5.4, 5.6, 3.9, E12, E25, E28, E34, E35): every rule that
 * reads the text and the body alone. Each refusal is a `RequestRefusal` with phase 0 and the key it names, made
 * before any call of any kind, which these pure functions cannot make: they take no client.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { routeListText } from "@/lib/db/console/completion";
import { ConsoleRefusal } from "@/lib/db/console/parser";
import {
  type MilvusPhase0,
  milvusMetadataReads,
  milvusPhase0,
  milvusVersionGates,
  parseMilvusRequest,
  type QueryPhase0,
} from "@/lib/db/providers/vector/milvus/request";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";

const CONTEXT = { database: "analytics" };

function phase0(text: string): MilvusPhase0 {
  return milvusPhase0(parseMilvusRequest(text), CONTEXT);
}

/** `POST /v2/vectordb/<route>` with `body` as its JSON body, written as the console takes it. */
function request(route: string, body: unknown): string {
  return `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;
}

function refusalOf(text: string): RequestRefusal {
  try {
    phase0(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error(`expected a refusal of ${text}`);
}

/** A refusal's phase, key and sentence together. */
function refused(text: string): { phase: number; key: string | null; message: string } {
  const error = refusalOf(text);
  return { phase: error.phase, key: error.key, message: error.message };
}

const VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

describe("parseMilvusRequest (3.4, 5.4)", () => {
  test("reads the long and the short form of a route", () => {
    expect(parseMilvusRequest(request("collections/list", {})).route.op).toBe("collections/list");
    expect(parseMilvusRequest('POST entities/get\n{"collectionName": "c", "id": 1}').route.op).toBe("entities/get");
  });

  test("a load, release or refresh points at the Operations controls (E9)", () => {
    for (const route of ["collections/load", "collections/release", "collections/refresh_load"]) {
      expect(refused(request(route, { collectionName: "c" }))).toEqual({
        phase: 0,
        key: null,
        message: `${route} changes what Milvus holds in memory and does not run from the console: an admin loads and releases a collection from the Operations controls.`,
      });
    }
  });

  const ROUTE_LIST = routeListText(MILVUS_CONSOLE, MILVUS_ROUTES, ["read"]);

  test("a write says the provider reads only and lists every route it runs (5.4)", () => {
    expect(refused(request("entities/insert", { collectionName: "c", data: [] }))).toEqual({
      phase: 0,
      key: null,
      message: `entities/insert is not available in this version of the Milvus provider, which reads only. Studio runs:\n${ROUTE_LIST}`,
    });
    for (const route of MILVUS_ROUTES) expect(ROUTE_LIST).toContain(route.template);
  });

  test("another documented route is named, with the routes Studio runs", () => {
    expect(refused("POST users/list\n{}").message).toBe(
      `Studio does not run POST /v2/vectordb/users/list; it runs:\n${ROUTE_LIST}`,
    );
  });

  test("a text pasted with Windows line endings is refused with the same sentence (Review Focus)", () => {
    expect(refused('POST /v2/vectordb/entities/insert\r\n{"collectionName": "c"}').message).toBe(
      `entities/insert is not available in this version of the Milvus provider, which reads only. Studio runs:\n${ROUTE_LIST}`,
    );
    expect(phase0('# a note\r\nPOST /v2/vectordb/collections/list\r\n{"dbName": "x"}\r\n')).toMatchObject({ db: "x" });
  });

  test("a route that is not plain route words keeps the grammar's own refusal", () => {
    const error = refusalOf(request("Entities/Insert", {}));
    expect(error).toBeInstanceOf(ConsoleRefusal);
    expect((error as ConsoleRefusal).reason).toBe("unknown-route");
  });

  test("a refusal that is not about the route passes through", () => {
    expect((refusalOf(`GET /v2/vectordb/collections/list`) as ConsoleRefusal).reason).toBe("unknown-method");
  });
});

describe("the metadata routes", () => {
  test.each([
    [request("databases/list", {}), { op: "databases/list", db: "analytics", gatedKeys: [] }],
    [request("databases/describe", { dbName: "sales" }), { op: "databases/describe", db: "sales", gatedKeys: [] }],
    [request("collections/list", {}), { op: "collections/list", db: "analytics", gatedKeys: [] }],
    [
      request("collections/describe", { collectionName: "docs" }),
      { op: "collections/describe", db: "analytics", gatedKeys: [], collection: "docs" },
    ],
    [
      request("collections/get_stats", { dbName: "default", collectionName: "docs" }),
      { op: "collections/get_stats", db: "default", gatedKeys: [], collection: "docs" },
    ],
    [
      request("collections/get_load_state", { collectionName: "docs", partitionNames: ["2024-01"] }),
      {
        op: "collections/get_load_state",
        db: "analytics",
        gatedKeys: [],
        collection: "docs",
        partitionNames: ["2024-01"],
      },
    ],
    [
      request("partitions/list", { collectionName: "docs" }),
      { op: "partitions/list", db: "analytics", gatedKeys: [], collection: "docs" },
    ],
    [
      request("indexes/list", { collectionName: "docs" }),
      { op: "indexes/list", db: "analytics", gatedKeys: [], collection: "docs" },
    ],
    [
      request("indexes/describe", { collectionName: "docs", indexName: "vec" }),
      { op: "indexes/describe", db: "analytics", gatedKeys: [], collection: "docs", indexName: "vec" },
    ],
    [request("aliases/list", {}), { op: "aliases/list", db: "analytics", gatedKeys: [], collection: undefined }],
    [
      request("aliases/list", { collectionName: "docs" }),
      { op: "aliases/list", db: "analytics", gatedKeys: [], collection: "docs" },
    ],
    [
      request("aliases/describe", { aliasName: "current" }),
      { op: "aliases/describe", db: "analytics", gatedKeys: [], alias: "current" },
    ],
  ])("%s", (text, expected) => {
    expect(phase0(text)).toEqual(expected as MilvusPhase0);
  });

  test("an absent body on a route whose body is optional reads as {}", () => {
    expect(phase0("POST /v2/vectordb/collections/list")).toEqual({
      op: "collections/list",
      db: "analytics",
      gatedKeys: [],
    });
  });

  test("dbName overrides the connection's database, so it is a default and not a boundary (E23)", () => {
    expect(phase0(request("collections/list", { dbName: "other" })).db).toBe("other");
  });

  test.each([
    ["a-b", "collectionName"],
    [" docs", "collectionName"],
    ["9docs", "collectionName"],
    ["a".repeat(256), "collectionName"],
  ])("collectionName %j is refused by Milvus's name rule, never trimmed (R43 M10)", (name, key) => {
    const result = refused(request("collections/describe", { collectionName: name }));
    expect(result.phase).toBe(0);
    expect(result.key).toBe(key);
    expect(result.message).toContain(
      "is not a Milvus name: a letter or underscore, then letters, digits or underscores, at most 255 characters, as typed.",
    );
  });

  test("a name of 255 characters is accepted", () => {
    expect(phase0(request("collections/describe", { collectionName: "a".repeat(255) }))).toMatchObject({
      collection: "a".repeat(255),
    });
  });

  test("a non-string name is refused", () => {
    expect(refused(request("collections/describe", { collectionName: 5 }))).toEqual({
      phase: 0,
      key: "collectionName",
      message: "collectionName takes a string.",
    });
  });

  test("dbName meets the same rule", () => {
    expect(refused(request("collections/list", { dbName: "x y" })).key).toBe("dbName");
  });

  test("an index name is 1 to 255 bytes, as typed", () => {
    expect(refused(request("indexes/describe", { collectionName: "c", indexName: "" }))).toEqual({
      phase: 0,
      key: "indexName",
      message: "indexName takes a name of 1 to 255 bytes.",
    });
    expect(refused(request("indexes/describe", { collectionName: "c", indexName: "é".repeat(128) })).key).toBe(
      "indexName",
    );
  });

  test("a missing required key is refused by name", () => {
    expect(refused(request("collections/describe", {}))).toEqual({
      phase: 0,
      key: "collectionName",
      message: "collections/describe needs collectionName.",
    });
  });

  test("an unknown key is refused by name, a prototype-named key included (VF5)", () => {
    expect(refused(request("collections/list", { dbname: "x" }))).toEqual({
      phase: 0,
      key: "dbname",
      message:
        'collections/list does not take "dbname": Studio refuses a key it does not know rather than let Milvus drop it, and it takes dbName.',
    });
    expect(refused(request("collections/list", { toString: 1 })).key).toBe("toString");
    expect(refused(request("collections/list", { constructor: 1 })).key).toBe("constructor");
  });

  test("a long unknown key is shown cut", () => {
    expect(refused(request("collections/list", { ["k".repeat(100)]: 1 })).message).toContain(`"${"k".repeat(64)}…"`);
  });

  test.each([
    [{ collectionName: "c", partitionNames: "p" }, "partitionNames", "partitionNames takes a list."],
    [
      { collectionName: "c", partitionNames: Array.from({ length: 1025 }, (_, index) => `p${index}`) },
      "partitionNames",
      "partitionNames holds 1025 entries; Studio sends at most 1024.",
    ],
    [
      { collectionName: "c", partitionNames: [""] },
      "partitionNames[0]",
      "partitionNames[0] takes a name of 1 to 255 bytes.",
    ],
  ])("partitionNames %j", (body, key, message) => {
    expect(refused(request("collections/get_load_state", body))).toEqual({ phase: 0, key, message });
  });
});

describe("entities/query (5.4)", () => {
  const query = (body: Record<string, unknown>) =>
    phase0(request("entities/query", { collectionName: "docs_int64", ...body })) as QueryPhase0;
  const refuseQuery = (body: Record<string, unknown>) =>
    refused(request("entities/query", { collectionName: "docs_int64", ...body }));

  test("an absent limit is 100 and an absent offset 0 (R08 F14)", () => {
    expect(query({})).toEqual({
      op: "entities/query",
      db: "analytics",
      gatedKeys: [],
      collection: "docs_int64",
      filter: "",
      output: { kind: "default" },
      limit: 100,
      offset: 0,
      partitionNames: [],
      templates: {},
      consistency: { kind: "default" },
      orderByFields: [],
    });
  });

  test("example 3 of 5.4 reads its filter, outputs and limit", () => {
    expect(
      query({
        filter: 'seq >= 10 and title like "doc 001%"',
        outputFields: ["id", "seq", "title", "tags", "big_int"],
        limit: 5,
      }),
    ).toMatchObject({
      filter: 'seq >= 10 and title like "doc 001%"',
      limit: 5,
      output: { kind: "named", entries: ["id", "seq", "title", "tags", "big_int"] },
    });
  });

  test("an explicit limit 0 is refused, because REST reads it as every row (R03 F9)", () => {
    expect(refuseQuery({ limit: 0 })).toEqual({
      phase: 0,
      key: "limit",
      message: "limit 0 would read every row in REST; Studio takes 1 to 1000.",
    });
  });

  test.each([
    [{ limit: 1001 }, "limit", 'limit is "1001"; Studio accepts 1 to 1000.'],
    [{ limit: -1 }, "limit", 'limit is "-1"; Studio accepts 1 to 1000.'],
    [{ offset: -1 }, "offset", 'offset is "-1"; Studio accepts 0 to 16384.'],
  ])("%j is refused", (body, key, message) => {
    expect(refuseQuery(body)).toEqual({ phase: 0, key, message });
  });

  test("a limit past the safe range is refused with its digits as typed", () => {
    expect(refused('POST entities/query\n{"collectionName": "c", "limit": 99999999999999999999}')).toEqual({
      phase: 0,
      key: "limit",
      message: 'limit is "99999999999999999999"; Studio accepts 1 to 1000.',
    });
  });

  test.each([
    ['"limit": "10"', "a string"],
    ['"limit": 1.5', "a fraction"],
    ['"limit": 1e1', "an exponent"],
    ['"limit": 10.0', "an integral double"],
    ['"limit": {"kind": "int", "digits": "42"}', "a tag-shaped object (3.4)"],
    ['"limit": null', "null"],
  ])("%s, %s, is refused: an integer option takes only an integer literal (E12)", (pair) => {
    expect(refused(`POST entities/query\n{"collectionName": "c", ${pair}}`)).toEqual({
      phase: 0,
      key: "limit",
      message: "limit takes a JSON integer such as 10, written without quotes, a fraction or an exponent.",
    });
  });

  test("offset plus limit past 16,384 is refused (5.6)", () => {
    expect(refuseQuery({ offset: 16_000, limit: 1000 })).toEqual({
      phase: 0,
      key: "offset",
      message: "offset plus limit is 17000; Milvus reads at most 16,384 rows deep, so Studio refuses past it.",
    });
    expect(query({ offset: 15_384, limit: 1000 })).toMatchObject({ offset: 15_384, limit: 1000 });
  });

  describe("the lone count (5.4, R40 M23)", () => {
    test("example 4: count(*) alone is a count, sent with no limit", () => {
      expect(query({ filter: "maybe_count is null", outputFields: ["count(*)"] }).output).toEqual({ kind: "count" });
    });

    test("compared trimmed and case-insensitively", () => {
      expect(query({ outputFields: [" COUNT(*) "] }).output).toEqual({ kind: "count" });
    });

    test.each([
      [{ limit: 10 }, "limit"],
      [{ limit: 0 }, "limit"],
      [{ offset: 5 }, "offset"],
      [{ offset: 0 }, "offset"],
    ])("%j is refused: a count takes no limit or offset", (body, key) => {
      expect(refuseQuery({ outputFields: ["count(*)"], ...body })).toEqual({
        phase: 0,
        key,
        message:
          "A count takes no limit or offset: Milvus refuses a count with a limit (count entities with pagination is not allowed) and ignores an offset alone.",
      });
    });

    test("a count mixed with a regular field is refused naming the field", () => {
      expect(refuseQuery({ outputFields: ["count(*)", "seq"] })).toEqual({
        phase: 0,
        key: "outputFields",
        message: 'count(*) is read alone, and this request also names "seq".',
      });
      expect(refuseQuery({ outputFields: ["count(*)", "count(*)"] }).message).toBe(
        'count(*) is read alone, and this request also names "count(*)".',
      );
    });

    test.each(["count(seq)", "sum(x)"])("%s is server aggregation, refused by name", (entry) => {
      expect(refuseQuery({ outputFields: [entry] })).toEqual({
        phase: 0,
        key: "outputFields",
        message: `"${entry}" is a server aggregation, which Studio does not run: only a lone count(*) is read.`,
      });
    });
  });

  test("the bracket form of a dynamic key is refused naming $meta and the bare form", () => {
    expect(refuseQuery({ outputFields: ['$meta["big_int"]'] })).toEqual({
      phase: 0,
      key: "outputFields",
      message: '"$meta[\\"big_int\\"]": name the dynamic key bare, as "big_int", or name $meta for every dynamic key.',
    });
  });

  test.each([
    [
      { outputFields: [] },
      "outputFields",
      "outputFields is empty: leave it out for the default columns, or name fields.",
    ],
    [{ outputFields: "id" }, "outputFields", "outputFields takes a list."],
    [
      { outputFields: Array.from({ length: 257 }, (_, index) => `f${index}`) },
      "outputFields",
      "outputFields holds 257 entries; Studio sends at most 256.",
    ],
    [{ outputFields: [""] }, "outputFields[0]", "outputFields[0] takes a name of 1 to 255 bytes."],
  ])("outputFields %j is refused", (body, key, message) => {
    expect(refuseQuery(body)).toEqual({ phase: 0, key, message });
  });

  test("a field name is never trimmed: ' a' passes phase 0 as typed", () => {
    expect(query({ outputFields: [" a"] }).output).toEqual({ kind: "named", entries: [" a"] });
  });

  describe("consistency (R40 M24)", () => {
    test.each(["Strong", "Bounded", "Eventually"])("%s is sent as a level", (level) => {
      expect(query({ consistencyLevel: level }).consistency).toEqual({ kind: "level", level });
    });

    test.each([
      [
        "Session",
        "consistencyLevel Session is refused: Studio holds no write timestamp, so Session reads no newer data than Eventually.",
      ],
      [
        "Customized",
        "consistencyLevel Customized is refused: it needs a guarantee timestamp, which Studio does not send.",
      ],
      ["strong", 'consistencyLevel takes Strong, Bounded, Eventually, not "strong".'],
      ["constructor", 'consistencyLevel takes Strong, Bounded, Eventually, not "constructor".'],
    ])("%s is refused", (level, message) => {
      expect(refuseQuery({ consistencyLevel: level })).toEqual({ phase: 0, key: "consistencyLevel", message });
    });
  });

  describe("exprParams (5.4, E12)", () => {
    test("each scalar and list type becomes its template value", () => {
      const parsed = phase0(
        'POST entities/query\n{"collectionName": "c", "filter": "x", "exprParams": {"s": "a\\"b", "b": true, "i": 9223372036854775807, "f": 1.5, "n": -9223372036854775808, "ints": [1, 2], "strs": ["a"], "bools": [false], "floats": [0.5], "mixed": [1, 2.5]}}',
      ) as QueryPhase0;
      expect({ ...parsed.templates }).toEqual({
        s: { kind: "string", value: 'a"b' },
        b: { kind: "bool", value: true },
        i: { kind: "int64", digits: "9223372036854775807" },
        f: { kind: "double", value: 1.5 },
        n: { kind: "int64", digits: "-9223372036854775808" },
        ints: { kind: "int64-array", values: ["1", "2"] },
        strs: { kind: "string-array", values: ["a"] },
        bools: { kind: "bool-array", values: [false] },
        floats: { kind: "double-array", values: [0.5] },
        mixed: { kind: "double-array", values: [1, 2.5] },
      });
    });

    test("469489107428444015 typed as a number stays its digits, and 5 and 9007199254740993 are both integers (E26)", () => {
      const parsed = phase0(
        'POST entities/query\n{"collectionName": "c", "exprParams": {"a": 469489107428444015, "b": 5, "c": 9007199254740993, "d": "469489107428444015"}}',
      ) as QueryPhase0;
      expect({ ...parsed.templates }).toEqual({
        a: { kind: "int64", digits: "469489107428444015" },
        b: { kind: "int64", digits: "5" },
        c: { kind: "int64", digits: "9007199254740993" },
        d: { kind: "string", value: "469489107428444015" },
      });
    });

    test.each([
      [
        '{"v": 9223372036854775808}',
        "exprParams.v",
        "exprParams.v is outside the Int64 range or not written as plain digits.",
      ],
      [
        '{"v": -9223372036854775809}',
        "exprParams.v",
        "exprParams.v is outside the Int64 range or not written as plain digits.",
      ],
      ['{"v": -0}', "exprParams.v", "exprParams.v is outside the Int64 range or not written as plain digits."],
      ['{"v": 1e400}', "exprParams.v", "exprParams.v must be a finite number."],
      ['{"v": null}', "exprParams.v", "exprParams.v takes a string, a number, true or false, or a list of them."],
      ['{"v": {"w": 1}}', "exprParams.v", "exprParams.v takes a string, a number, true or false, or a list of them."],
      [
        '{"v": [[1]]}',
        "exprParams.v[0]",
        "exprParams.v[0] takes a string, a number, true or false, or a list of them.",
      ],
      ['{"v": []}', "exprParams.v", "exprParams.v is an empty list, which has no element type to send."],
      ['{"v": [1, "a"]}', "exprParams.v", "exprParams.v mixes value types: a template list holds one type."],
      [
        '{"v": [9007199254740993, 0.5]}',
        "exprParams.v",
        "exprParams.v mixes fractions with an integer beyond 2^53, which no double holds exactly.",
      ],
      ['{"constructor": 1}', "exprParams.constructor", "constructor cannot name a template value."],
      ['{"prototype": 1}', "exprParams.prototype", "prototype cannot name a template value."],
      ['{"a b": 1}', "exprParams.a b", '"a b" cannot name a template value: a template name is an identifier.'],
    ])("exprParams %s is refused", (params, key, message) => {
      expect(refused(`POST entities/query\n{"collectionName": "c", "exprParams": ${params}}`)).toEqual({
        phase: 0,
        key,
        message,
      });
    });

    test("at most 32 keys, and lists of at most 1,000 values", () => {
      const keys = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index]));
      expect(refuseQuery({ exprParams: keys }).message).toBe("exprParams holds 33 values; Studio sends at most 32.");
      expect(refuseQuery({ exprParams: { v: Array.from({ length: 1001 }, () => 1) } }).message).toBe(
        "exprParams.v holds 1001 entries; Studio sends at most 1000.",
      );
      expect(refuseQuery({ exprParams: [1] }).message).toBe("exprParams takes an object.");
    });
  });

  test("a filter is a string, and every filter of a request sums to at most 64 KiB (R42 F2)", () => {
    expect(refuseQuery({ filter: 5 })).toEqual({ phase: 0, key: "filter", message: "filter takes a string." });
    expect(query({ filter: "a".repeat(65_536) }).filter).toHaveLength(65_536);
    expect(refuseQuery({ filter: "é".repeat(32_769) })).toEqual({
      phase: 0,
      key: "filter",
      message:
        "The filters of this request are 65538 bytes; Studio sends at most 65,536 bytes of filter text in one request, because Milvus keeps parsing a filter after a cancel.",
    });
  });

  test("orderByFields takes field names with an optional direction", () => {
    expect(query({ orderByFields: ["seq:desc", "title"] })).toMatchObject({
      orderByFields: ["seq:desc", "title"],
      gatedKeys: ["orderByFields"],
    });
    expect(refuseQuery({ orderByFields: ["seq desc"] })).toEqual({
      phase: 0,
      key: "orderByFields[0]",
      message: 'orderByFields[0] "seq desc": write a field name, optionally followed by :asc or :desc.',
    });
    expect(refuseQuery({ orderByFields: [1] }).message).toBe("orderByFields[0] takes a string.");
  });

  test("groupByFields is refused with its reason (R40 M16)", () => {
    expect(refuseQuery({ groupByFields: ["label"] })).toEqual({
      phase: 0,
      key: "groupByFields",
      message:
        "groupByFields is not available: Milvus documents no REST form of query aggregation, so Studio does not send it.",
    });
  });
});

describe("milvusVersionGates (5.9, 3.9)", () => {
  const ordered = phase0(request("entities/query", { collectionName: "c", orderByFields: ["seq"] }));

  test("a gated key the server lacks is refused in phase 0, with the gate's sentence", () => {
    const asked: string[] = [];
    let thrown: unknown;
    try {
      milvusVersionGates(ordered, (gate) => {
        asked.push(gate);
        return "orderByFields needs Milvus 3.0 or later.";
      });
    } catch (error) {
      thrown = error;
    }
    expect(asked).toEqual(["orderByFields"]);
    expect(thrown).toBeInstanceOf(RequestRefusal);
    expect(thrown).toMatchObject({
      phase: 0,
      key: "orderByFields",
      message: "orderByFields needs Milvus 3.0 or later.",
    });
  });

  test("a server that honours it passes, and a request without the key is never asked about", () => {
    expect(() => milvusVersionGates(ordered, () => undefined)).not.toThrow();
    const asked: string[] = [];
    milvusVersionGates(phase0(request("entities/query", { collectionName: "c" })), (gate) => {
      asked.push(gate);
      return "never";
    });
    expect(asked).toEqual([]);
  });
});

describe("entities/get (5.4)", () => {
  test("one id or a list, as typed", () => {
    expect(phase0(request("entities/get", { collectionName: "c", id: 1 }))).toMatchObject({
      op: "entities/get",
      ids: [expect.anything()],
    });
    expect(phase0(request("entities/get", { collectionName: "c", id: ["vc-0001", "vc-0002"] }))).toMatchObject({
      ids: ["vc-0001", "vc-0002"],
      output: { kind: "default" },
      partitionNames: [],
      consistency: { kind: "default" },
    });
  });

  test.each([
    [{ id: [] }, "id", "id names no entity: give one id or a list of ids."],
    [{ id: Array.from({ length: 1001 }, (_, index) => index) }, "id", "id names 1001 ids; Studio sends at most 1000."],
    [{ id: [1.5] }, "id[0]", "id takes integers or strings, as the primary key is typed."],
    [{ id: [{ kind: "int", digits: "42" }] }, "id[0]", "id takes integers or strings, as the primary key is typed."],
    [{ id: [null] }, "id[0]", "id takes integers or strings, as the primary key is typed."],
    [{ id: 1, outputFields: ["count(*)"] }, "outputFields", "count(*) is read through entities/query only."],
    [
      { id: 1, partitionName: "p" },
      "partitionName",
      "partitionName is not read by Studio: name the partitions in partitionNames, a list.",
    ],
  ])("%j is refused", (body, key, message) => {
    expect(refused(request("entities/get", { collectionName: "c", ...body }))).toEqual({ phase: 0, key, message });
  });
});

describe("milvusMetadataReads (3.9)", () => {
  test.each([
    [request("collections/list", {}), { describeCollection: false, describeIndex: false }],
    [request("entities/query", { collectionName: "c" }), { describeCollection: true, describeIndex: false }],
    [request("entities/get", { collectionName: "c", id: 1 }), { describeCollection: true, describeIndex: false }],
    [
      request("entities/search", { collectionName: "c", annsField: "v", data: [VECTOR] }),
      { describeCollection: true, describeIndex: true },
    ],
    [
      request("entities/hybrid_search", {
        collectionName: "c",
        search: [{ annsField: "v", data: [VECTOR] }],
        rerank: { strategy: "rrf" },
      }),
      { describeCollection: true, describeIndex: false },
    ],
    [
      request("entities/hybrid_search", {
        collectionName: "c",
        search: [{ annsField: "v", data: [VECTOR], params: { ef: 100 } }],
        rerank: { strategy: "rrf" },
      }),
      { describeCollection: true, describeIndex: true },
    ],
    [
      request("entities/hybrid_search", {
        collectionName: "c",
        search: [{ annsField: "v", data: [VECTOR], metricType: "L2" }],
        rerank: { strategy: "rrf" },
      }),
      { describeCollection: true, describeIndex: true },
    ],
  ])("%s", (text, reads) => {
    expect(milvusMetadataReads(phase0(text))).toEqual(reads);
  });
});
