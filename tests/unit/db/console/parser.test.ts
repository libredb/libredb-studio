/**
 * The console grammar's reader (vector-family spec 3.4): every code of ConsoleRefusalCode refused by name at its
 * line and column, the order in which rules are checked, and what an accepted request holds.
 */
import { describe, expect, test } from "bun:test";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  ConsoleRefusal,
  type ConsoleRefusalCode,
  consoleTokens,
  parseConsole,
  readConsoleBody,
} from "@/lib/db/console/parser";
import { isTaggedFloat, isTaggedInt, toJsonText } from "@/lib/db/console/tagged-json";
import { MILVUS_ROUTES, MILVUS_STAND_IN, QDRANT_ROUTES, QDRANT_STAND_IN } from "../../../helpers/console-stand-ins";

function refusalOf(spec: ConsoleDialectSpec, routes: readonly RouteSpec[], text: string): ConsoleRefusal {
  try {
    parseConsole(spec, routes, text);
  } catch (error) {
    if (error instanceof ConsoleRefusal) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be refused`);
}

const M = [MILVUS_STAND_IN, MILVUS_ROUTES] as const;
const Q = [QDRANT_STAND_IN, QDRANT_ROUTES] as const;

describe("every refusal code, by name, at its line and column", () => {
  test.each([
    [
      M,
      "  \n\t",
      "empty",
      "The console text is empty: write a request line, a method and a route, and its JSON body. (line 1, column 1)",
    ],
    [
      M,
      `POST entities/search\n{"a": "${"x".repeat(1_048_576)}"}`,
      "too-large",
      "The text is 1048606 bytes, above the console's bound of 1048576 bytes. (line 1, column 1)",
    ],
    [
      M,
      `POST entities/search\n{"a": ${"[".repeat(32)}`,
      "too-deep",
      "The body nests objects and arrays deeper than the console's bound of 32. (line 2, column 38)",
    ],
    [
      M,
      `POST entities/search\n{"a": [${"{},".repeat(4_095)}{}]}`,
      "too-many-nodes",
      "The body holds more than 4096 objects, arrays and values, the console's bound. (line 2, column 12290)",
    ],
    [
      M,
      `POST entities/search\n{"a": [${"0,".repeat(262_144)}0]}`,
      "too-many-numbers",
      "The body holds more than 262144 numbers in its lists of numbers, the console's bound. (line 2, column 524296)",
    ],
    [
      M,
      `POST entities/search\n{"a": [${'"a",'.repeat(32_768)}"a"]}`,
      "too-many-scalars",
      "The body holds more than 32768 strings in its lists of strings, the console's bound. (line 2, column 131080)",
    ],
    [
      M,
      "# one\n# two",
      "no-request",
      "The text holds only comments: write a request line after them. (line 2, column 1)",
    ],
    [
      M,
      "POST entities/search\n{}\nPOST entities/search\n{}",
      "second-request",
      "The text holds a second request line: run one request at a time. (line 3, column 1)",
    ],
    [
      Q,
      "GET collections\nGET collections",
      "second-request",
      "The text holds a second request line: run one request at a time. (line 2, column 1)",
    ],
    [
      M,
      "POST entities/search\n# note\n{}",
      "comment-position",
      "A # comment is accepted only before the request line. (line 2, column 1)",
    ],
    [
      Q,
      'POST collections/docs/points/query\n{"a": 1 # note\n}',
      "comment-position",
      "A # comment is accepted only before the request line. (line 2, column 9)",
    ],
    [
      Q,
      "GET collections # note",
      "comment-position",
      "A # comment is accepted only before the request line. (line 1, column 17)",
    ],
    [
      M,
      'POST entities/search\n{"a": 1 // note\n}',
      "body-comment",
      "A // comment is not accepted after this console's request line. (line 2, column 9)",
    ],
    [
      M,
      "GET entities/search",
      "unknown-method",
      "GET is not a method this console takes: it takes POST. (line 1, column 1)",
    ],
    [
      Q,
      "  DELETE collections/docs",
      "unknown-method",
      "DELETE is not a method this console takes: it takes GET and POST. (line 1, column 3)",
    ],
    [
      M,
      "POST entities/delete\n{}",
      "unknown-route",
      "POST entities/delete is not a route this console runs. (line 1, column 6)",
    ],
    [
      M,
      "POST /entities/search\n{}",
      "unknown-route",
      "POST /entities/search is not a route this console runs. (line 1, column 6)",
    ],
    [Q, "POST collections", "unknown-route", "POST collections is not a route this console runs. (line 1, column 6)"],
    [M, "POST", "unknown-route", "POST needs a route after it. (line 1, column 5)"],
    [
      M,
      "POST http://localhost:19530/v2/vectordb/entities/search\n{}",
      "absolute-url",
      "A request names a route only, never a scheme or a host: the connection supplies both. (line 1, column 6)",
    ],
    [
      Q,
      "GET //evil.example/collections",
      "absolute-url",
      "A request names a route only, never a scheme or a host: the connection supplies both. (line 1, column 5)",
    ],
    [
      M,
      "POST entities/search\nAuthorization: Bearer x\n{}",
      "header-line",
      "A header line is not accepted: the connection supplies every header. (line 2, column 1)",
    ],
    [Q, "GET collections#top", "fragment", "A route takes no # fragment. (line 1, column 16)"],
    [
      M,
      "POST entities/search?limit=5\n{}",
      "query-key",
      "POST entities/search takes no query string. (line 1, column 22)",
    ],
    [
      Q,
      "GET collections/docs/points/42?wait=true",
      "query-key",
      "GET collections/{collection_name}/points/{id} takes no query key wait. (line 1, column 32)",
    ],
    [
      Q,
      "GET collections/docs/points/42?timeout=5&timeout=6",
      "query-key",
      "The query key timeout is given twice. (line 1, column 32)",
    ],
    [
      Q,
      "GET collections/docs/points/42?timeout=0",
      "query-value",
      "The query key timeout takes a positive integer, not 0. (line 1, column 32)",
    ],
    [
      Q,
      "GET collections/docs/points/42?consistency=most",
      "query-value",
      "The query key consistency takes a positive integer or one of majority, quorum, all, not most. (line 1, column 32)",
    ],
    [
      Q,
      "GET collections/docs/optimizations?with=queued,running",
      "query-value",
      "The query key with takes a comma-separated list of queued, completed, idle_segments, not queued,running. (line 1, column 36)",
    ],
    [
      Q,
      "GET collections/docs/points/42?timeout",
      "query-value",
      "The query key timeout takes a positive integer, not nothing. (line 1, column 32)",
    ],
    [
      Q,
      "GET collections/{collection_name}",
      "path-template",
      "Replace {collection_name} with a collection name. (line 1, column 5)",
    ],
    [Q, "GET collections/docs/points/{id}", "path-template", "Replace {id} with an id. (line 1, column 5)"],
    [M, "POST entities/{x\n{}", "path-template", "Replace {x} with a x. (line 1, column 6)"],
    [
      Q,
      "GET collections/docs/points/18446744073709551616",
      "path-param",
      "The point id 18446744073709551616 is neither an unsigned 64-bit integer nor a UUID. (line 1, column 5)",
    ],
    [
      Q,
      "GET collections/docs/points/-1",
      "path-param",
      "The point id -1 is neither an unsigned 64-bit integer nor a UUID. (line 1, column 5)",
    ],
    [Q, "GET collections//points/1", "path-param", "The path parameter collection_name is empty. (line 1, column 5)"],
    [
      Q,
      "GET collections/do%zz",
      "path-param",
      "The path segment do%zz is not valid percent-encoding. (line 1, column 5)",
    ],
    [Q, "GET collections\n{}", "body-not-allowed", "GET collections takes no body. (line 1, column 16)"],
    [M, "POST entities/search", "body-required", "POST entities/search needs a JSON body. (line 1, column 21)"],
    [
      M,
      'POST entities/search\n{"a": 1',
      "malformed-json",
      "The body ends before its closing bracket. (line 2, column 8)",
    ],
    [
      M,
      'POST entities/search\n["a"]',
      "malformed-json",
      "Expected the body, one JSON object starting with {, found [. (line 2, column 1)",
    ],
    [M, 'POST entities/search\n{"a" 1}', "malformed-json", "Expected :, found 1. (line 2, column 6)"],
    [
      M,
      "POST entities/search\n{a: 1}",
      "malformed-json",
      "Expected a key in double quotes, found a. (line 2, column 2)",
    ],
    [M, 'POST entities/search\n{"a": 1 "b": 2}', "malformed-json", 'Expected , or }, found "b". (line 2, column 9)'],
    [M, 'POST entities/search\n{"a": [1 2]}', "malformed-json", "Expected , or ], found 2. (line 2, column 10)"],
    [
      M,
      'POST entities/search\n{"a": "\\x"}',
      "malformed-json",
      'The string "\\x" holds an escape or a character JSON does not allow. (line 2, column 7)',
    ],
    [M, 'POST entities/search\n{"a": NaN}', "malformed-json", "Expected a value, found NaN. (line 2, column 7)"],
    [
      M,
      "POST entities/search\n{} trailing",
      "malformed-json",
      "Expected nothing after the body, found trailing. (line 2, column 4)",
    ],
    [
      M,
      "POST entities/search HTTP/1.1\n{}",
      "malformed-json",
      "Expected the body, one JSON object starting with {, found HTTP/1.1. (line 1, column 22)",
    ],
    [
      M,
      'POST entities/search\n{"a": "http://x}',
      "unterminated-string",
      "A string is not closed before the end of its line. (line 2, column 7)",
    ],
    [
      M,
      'POST entities/search\n{"a": ...}',
      "ellipsis",
      "Replace ... with the values it stands for: the console runs the text as written. (line 2, column 7)",
    ],
    [
      M,
      'POST entities/search\n{"a": [1, …]}',
      "ellipsis",
      "Replace ... with the values it stands for: the console runs the text as written. (line 2, column 11)",
    ],
    [
      M,
      'POST entities/search\n{"a": 1,}',
      "trailing-comma",
      "Remove the comma before the closing bracket: JSON allows no trailing comma. (line 2, column 8)",
    ],
    [
      M,
      'POST entities/search\n{"a": [1,]}',
      "trailing-comma",
      "Remove the comma before the closing bracket: JSON allows no trailing comma. (line 2, column 9)",
    ],
    [
      M,
      'POST entities/search\n{"a": {"b": 1, "b": 2}}',
      "duplicate-key",
      'The key "b" is given twice in one object. (line 2, column 16)',
    ],
    [
      M,
      'POST entities/search\n{"a": {"__proto__": {}}}',
      "prototype-key",
      "The key __proto__ is not accepted. (line 2, column 8)",
    ],
  ] as const)("case %#", ([spec, routes], text, code, message) => {
    const refusal = refusalOf(spec, routes, text);
    expect({ code: refusal.reason, message: refusal.message }).toEqual({ code: code as ConsoleRefusalCode, message });
  });

  test("a duplicate key and a prototype key name the key", () => {
    expect(refusalOf(...M, 'POST entities/search\n{"a": 1, "a": 2}').key).toBe("a");
    expect(refusalOf(...M, 'POST entities/search\n{"__proto__": 1}').key).toBe("__proto__");
  });

  test("every refusal is a phase 0 RequestRefusal with the line and column it names", () => {
    const refusal = refusalOf(...M, "POST entities/search\n{,}");
    expect(refusal).toBeInstanceOf(RequestRefusal);
    expect({
      name: refusal.name,
      phase: refusal.phase,
      line: refusal.line,
      column: refusal.column,
      key: refusal.key,
    }).toEqual({
      name: "ConsoleRefusal",
      phase: 0,
      line: 2,
      column: 2,
      key: null,
    });
  });
});

describe("the order of the rules", () => {
  test("the text bound comes before the lexer, so an oversize text is never tokenised", () => {
    expect(refusalOf(...M, `${"[".repeat(1_048_577)}`).reason).toBe("too-large");
  });

  test("the body bounds come before the request line", () => {
    expect(refusalOf(...M, `GET nowhere\n{"a": ${"[".repeat(40)}`).reason).toBe("too-deep");
  });

  test("the route comes before the body's grammar", () => {
    expect(refusalOf(...M, 'POST entities/delete\n{"a": ...}').reason).toBe("unknown-route");
  });

  test("a body's grammar comes before whether the route takes a body", () => {
    expect(refusalOf(...Q, "GET collections\n{,}").reason).toBe("malformed-json");
  });
});

describe("what the bounds charge, and where the read stops", () => {
  test("an array that closes empty is a node, so empty arrays meet the node bound as empty objects do", () => {
    const inList = refusalOf(...M, `POST entities/search {"a":[${Array(4_097).fill("[]").join(",")}]}`);
    expect(inList.reason).toBe("too-many-nodes");
    const members = Array.from({ length: 4_097 }, (_, index) => `"k${index}":[]`).join(",");
    expect(refusalOf(...M, `POST entities/search {${members}}`).reason).toBe("too-many-nodes");
    expect(toJsonText(parseConsole(...M, 'POST entities/search {"a":[[],[]],"b":[]}').body)).toBe(
      '{"a":[[],[]],"b":[]}',
    );
  });

  test("the read stops at the first token the body's grammar cannot take, so the rest of the text is never tokenised", () => {
    const kept = (text: string) => consoleTokens(QDRANT_STAND_IN, text).tokens.flat().length;
    const head = 'POST collections/docs/points/query {"a": [';
    const wellFormed = kept(head);
    for (const flood of [":", ",", '"k":', "x ", "}", "# ", "1 "]) {
      const text = head + flood.repeat(100_000);
      expect({ flood, kept: kept(text) - wellFormed <= 3 }).toEqual({ flood, kept: true });
    }
    expect(kept(`POST collections ${"x ".repeat(100_000)}`)).toBeLessThanOrEqual(5);
    expect(kept(`POST collections {}${" x".repeat(100_000)}`)).toBeLessThanOrEqual(8);
    expect(kept(`POST collections\n{"a": 1,\n,${"\n:".repeat(100_000)}`)).toBeLessThanOrEqual(12);
  });

  test("a blank line and a line of whitespace keep no token, so a text of them costs its lines alone", () => {
    const read = consoleTokens(QDRANT_STAND_IN, `POST collections {\n\n \t\r\n${" \n".repeat(1_000)}}`);
    expect(read.tokens.length).toBe(1_004);
    expect(read.tokens.flat().length).toBe(4);
    expect(new Set(read.tokens.slice(1, 1_003)).size).toBe(1);
    expect(toJsonText(readConsoleBody(QDRANT_STAND_IN, read) ?? "none")).toBe("{}");
  });

  test("whitespace is never kept, and comments only for a reader that asks, so neither grows what a request holds", () => {
    const text = '// a\nPOST collections/docs/points/query // b\n{ "a" : 1 // c\n// d\n}\n// e';
    const kinds = (comments?: boolean) =>
      consoleTokens(QDRANT_STAND_IN, text, comments).tokens.map((line) => line.map((token) => token.kind).join(" "));
    expect(kinds()).toEqual(["", "method path", "punctuation key punctuation number", "", "punctuation", ""]);
    expect(kinds(true)).toEqual([
      "comment",
      "method path comment",
      "punctuation key punctuation number comment",
      "comment",
      "punctuation",
      "comment",
    ]);
    const flood = consoleTokens(QDRANT_STAND_IN, `POST collections {${"\n//".repeat(100_000)}\n}`);
    expect(flood.tokens.flat().length).toBe(4);
    expect(
      toJsonText(parseConsole(...Q, `POST collections/docs/points/scroll {${"\n// note".repeat(10_000)}\n}`).body),
    ).toBe("{}");
  });

  test("a text read short is refused with the sentence the whole text would get", () => {
    const head = 'POST collections/docs/points/query\n{"a": [';
    expect(refusalOf(...Q, `${head}${":".repeat(1_000)}`).message).toBe(
      "Expected a value, found :. (line 2, column 8)",
    );
    expect(refusalOf(...Q, `${head}1 2`).message).toBe("Expected , or ], found 2. (line 2, column 10)");
    expect(refusalOf(...Q, `${head}1,]}`).reason).toBe("trailing-comma");
    expect(refusalOf(...Q, `${head}1}`).message).toBe("Expected , or ], found }. (line 2, column 9)");
    expect(refusalOf(...Q, `${head}"k": 1]}`).message).toBe('Expected a value, found "k". (line 2, column 8)');
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a" 1}').message).toBe(
      "Expected :, found 1. (line 2, column 6)",
    );
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a": 1 "b": 2}').message).toBe(
      'Expected , or }, found "b". (line 2, column 9)',
    );
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a": 1,}').reason).toBe("trailing-comma");
    expect(refusalOf(...Q, "POST collections/docs/points/query\n{1: 2}").message).toBe(
      "Expected a key in double quotes, found 1. (line 2, column 2)",
    );
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a": 1, 2}').message).toBe(
      "Expected a key in double quotes, found 2. (line 2, column 10)",
    );
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a": ]}').message).toBe(
      "Expected a value, found ]. (line 2, column 7)",
    );
    expect(refusalOf(...Q, 'POST collections/docs/points/query\n{"a": 1}\n{"b": 2}').message).toBe(
      'Expected nothing after the body, found {"b": 2}. (line 3, column 1)',
    );
    expect(refusalOf(...Q, "POST collections/docs/points/query\n[1]").message).toBe(
      "Expected the body, one JSON object starting with {, found [. (line 2, column 1)",
    );
  });

  test("a grammar error before a bound is named as the grammar error, the first thing wrong with the text", () => {
    expect(refusalOf(...M, `POST entities/search\n{"a": [:${"[".repeat(40)}`).reason).toBe("malformed-json");
  });
});

describe("an accepted request", () => {
  test("with the prefix and in the short form, a comment before it, and a body on the request line", () => {
    for (const text of [
      '# find\nPOST /v2/vectordb/entities/search\n{"collectionName": "docs", "limit": 5}',
      'POST entities/search {"collectionName": "docs", "limit": 5}',
      '\n\nPOST entities/search\n\n{"collectionName": "docs",\n "limit": 5}\n\n',
    ]) {
      const request = parseConsole(...M, text);
      expect(request.route.op).toBe("entities.search");
      expect(toJsonText(request.body)).toBe('{"collectionName":"docs","limit":5}');
    }
  });

  test("integers keep their digits whatever their size, floats their text", () => {
    const request = parseConsole(...M, 'POST entities/query\n{"id": 18446744073709551615, "f": 1.50, "e": -1e-7}');
    expect(isTaggedInt(request.body.id)).toBe(true);
    expect(isTaggedFloat(request.body.f)).toBe(true);
    expect(toJsonText(request.body)).toBe('{"id":18446744073709551615,"f":1.50,"e":-1e-7}');
  });

  test("an object is built on no prototype, so no key reaches Object.prototype, and the body is frozen", () => {
    const request = parseConsole(...M, 'POST entities/query\n{"constructor": {"prototype": 1}, "toString": 2}');
    expect(Object.getPrototypeOf(request.body)).toBeNull();
    expect(Object.getPrototypeOf(request.body.constructor)).toBeNull();
    expect(Object.isFrozen(request.body)).toBe(true);
    expect(({} as Record<string, unknown>).prototype).toBeUndefined();
  });

  test("a tag-shaped object is an object", () => {
    const request = parseConsole(...M, 'POST entities/query\n{"limit": {"kind": "int", "digits": "42"}}');
    expect(isTaggedInt(request.body.limit)).toBe(false);
    expect(toJsonText(request.body)).toBe('{"limit":{"kind":"int","digits":"42"}}');
  });

  test("path parameters percent-decoded, a UUID point id, query keys the route declares", () => {
    const request = parseConsole(
      ...Q,
      "GET /collections/my%20docs/points/550e8400-e29b-41d4-a716-446655440000?consistency=2&timeout=30",
    );
    expect(request.params).toEqual({ collection_name: "my docs", id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(request.query).toEqual({ consistency: "2", timeout: "30" });
  });

  test("a literal segment wins over a parameter", () => {
    expect(parseConsole(...Q, "GET collections/aliases").route.op).toBe("get_collections_aliases");
    expect(parseConsole(...Q, "GET collections/docs").route.op).toBe("get_collection");
  });

  test("the root route, an optional body absent, a // comment in the body and after it", () => {
    expect(parseConsole(...Q, "GET /").route.op).toBe("root");
    expect(toJsonText(parseConsole(...Q, "POST collections/docs/points/scroll").body)).toBe("{}");
    const commented = parseConsole(
      ...Q,
      '// note\nPOST collections/docs/points/query\n{\n  "limit": 3 // three\n} // done',
    );
    expect(toJsonText(commented.body)).toBe('{"limit":3}');
    expect(toJsonText(parseConsole(...M, "POST collections/list").body)).toBe("{}");
  });
});

describe("line endings", () => {
  test("a text with CRLF line endings reads as the same text with LF", () => {
    const crlf = '# find\r\nPOST entities/search\r\n{\r\n  "limit": 5,\r\n  "data": [[0.1]]\r\n}\r\n';
    expect(toJsonText(parseConsole(...M, crlf).body)).toBe(
      toJsonText(parseConsole(...M, crlf.replace(/\r/g, "")).body),
    );
  });
});

describe("consoleTokens and readConsoleBody", () => {
  test("find the request line and read the body from the end of its target", () => {
    const read = consoleTokens(QDRANT_STAND_IN, '// a\n\n  GET collections {"x": 1}');
    expect(read.request).toEqual({
      line: 2,
      method: "GET",
      methodColumn: 2,
      target: "collections",
      targetColumn: 6,
      bodyColumn: 17,
    });
    expect(toJsonText(readConsoleBody(QDRANT_STAND_IN, read) ?? "none")).toBe('{"x":1}');
    expect(readConsoleBody(QDRANT_STAND_IN, consoleTokens(QDRANT_STAND_IN, "GET collections // no body"))).toBeNull();
  });
});
