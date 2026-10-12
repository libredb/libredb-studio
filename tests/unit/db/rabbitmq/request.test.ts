/**
 * The read request (R-S9): every refused form raises before any I/O with its own sentence, and every accepted form
 * becomes the typed start the AMQP consume encodes, keywords and intervals as strings, offsets as 64-bit integers
 * and instants as whole seconds.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  FROM_FORMS,
  LIMIT_RANGE,
  NAMES_REQUIRED,
  OFFSET_NOT_WHOLE,
  OFFSET_TOO_LARGE,
  REQUEST_NOT_OBJECT,
  repeatedRequestKey,
  TIMESTAMP_BEFORE_EPOCH,
  TIMESTAMP_DAY,
  TIMESTAMP_FORM,
  unknownRequestKey,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { parseReadRequest } from "@/lib/db/providers/stream/rabbitmq/request";

/** Built from code points: a literal bidi control in source is invisible in review. */
const E_ACUTE = String.fromCodePoint(0xe9);
const RLO = String.fromCodePoint(0x202e);

const read = (fields: Record<string, unknown>) => JSON.stringify({ vhost: "/", stream: "orders", ...fields });

function refusal(text: string): QueryError {
  try {
    parseReadRequest(text);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error as QueryError;
  }
  throw new Error(`accepted: ${text}`);
}

describe("accepted requests", () => {
  test("the defaults: from last, limit 50", () => {
    expect(parseReadRequest(read({}))).toEqual({
      vhost: "/",
      stream: "orders",
      from: { kind: "keyword", value: "last" },
      startText: '"last"',
      limit: 50,
    });
  });

  test.each(["first", "last", "next"] as const)("the keyword %s", (keyword) => {
    const request = parseReadRequest(read({ from: keyword, limit: 500 }));
    expect(request.from).toEqual({ kind: "keyword", value: keyword });
    expect(request.startText).toBe(`"${keyword}"`);
    expect(request.limit).toBe(500);
  });

  test.each([
    [0, BigInt(0)],
    [9007199254740991, BigInt("9007199254740991")],
    ["120", BigInt(120)],
    ["9223372036854775807", BigInt("9223372036854775807")],
  ])("the offset %p", (offset, expected) => {
    const request = parseReadRequest(read({ from: { offset } }));
    expect(request.from).toEqual({ kind: "offset", value: expected });
    expect(request.startText).toBe(`{"offset": "${expected}"}`);
  });

  test.each([
    ["2026-10-11T08:30Z", BigInt(1791707400), "2026-10-11T08:30:00.000Z"],
    ["2026-10-11T08:30:15.999Z", BigInt(1791707415), "2026-10-11T08:30:15.000Z"],
    ["2026-10-11T11:30:15+03:00", BigInt(1791707415), "2026-10-11T08:30:15.000Z"],
    ["1970-01-01T00:00:00Z", BigInt(0), "1970-01-01T00:00:00.000Z"],
    ["2024-02-29T00:00:00Z", BigInt(1709164800), "2024-02-29T00:00:00.000Z"],
  ])("the timestamp %s rounds down to whole seconds", (timestamp, seconds, iso) => {
    const request = parseReadRequest(read({ from: { timestamp } }));
    expect(request.from).toEqual({ kind: "timestamp", seconds });
    expect(request.startText).toBe(`{"timestamp": "${iso}"}`);
  });

  test.each(["1Y", "6M", "7D", "12h", "30m", "45s", "1000000s"])("the age %s", (age) => {
    const request = parseReadRequest(read({ from: { age } }));
    expect(request.from).toEqual({ kind: "age", value: age });
    expect(request.startText).toBe(`{"age": "${age}"}`);
  });

  test("names that look like syntax are kept as written, the 255-byte multibyte name included", () => {
    const long = E_ACUTE.repeat(127) + "x";
    expect(new TextEncoder().encode(long).length).toBe(255);
    for (const name of ["/", "%2F", "a b", "a,b", 'q"t', "line\nbreak", `${RLO}evil`, long]) {
      const request = parseReadRequest(JSON.stringify({ vhost: name, stream: name }));
      expect(request.vhost).toBe(name);
      expect(request.stream).toBe(name);
    }
  });
});

describe("refused requests, each with its sentence", () => {
  test.each(["not json", "[]", "null", '"text"', "42"])("not one object: %s", (text) => {
    expect(refusal(text).message).toBe(REQUEST_NOT_OBJECT);
  });

  test("a key written twice is refused by name, at the top and inside from, an escaped spelling included", () => {
    // JSON.parse keeps the last of two equal keys, so the read would run on another vhost than the first one written.
    expect(refusal('{"vhost":"/","vhost":"a","stream":"s"}').message).toBe(repeatedRequestKey("vhost"));
    expect(refusal('{"vhost":"/","stream":"s","st\\u0072eam":"t"}').message).toBe(repeatedRequestKey("stream"));
    expect(refusal('{"vhost":"/","stream":"s","from":{"offset":"1","offset":"2"}}').message).toBe(
      repeatedRequestKey("offset"),
    );
    expect(refusal('{"vhost":"/","stream":"s","limit":[{"a":1},{"a":2,"a":3}]}').message).toBe(repeatedRequestKey("a"));
    // A key's spelling inside a string value is not a key, and equal keys in two objects are not a repeat.
    expect(parseReadRequest('{"vhost":"\\"vhost\\":","stream":"s"}').vhost).toBe('"vhost":');
    expect(refusal('{"vhost":"/","stream":"s","limit":[{"a":1},{"a":2}]}').message).toBe(LIMIT_RANGE);
    expect(repeatedRequestKey("vhost")).toBe('The read request names "vhost" more than once; write each key once.');
  });

  test("an unknown key is named", () => {
    expect(refusal(read({ topic: "orders" })).message).toBe(unknownRequestKey("topic"));
    expect(refusal(read({ scope: "billing" })).message).toBe(unknownRequestKey("scope"));
  });

  test.each([
    [{ vhost: undefined }],
    [{ vhost: "" }],
    [{ vhost: "." }],
    [{ stream: ".." }],
    [{ stream: 7 }],
    [{ stream: "a\u0000b" }],
    [{ stream: "x".repeat(256) }],
    [{ vhost: E_ACUTE.repeat(128) }],
  ])("a name outside the rule: %p", (fields) => {
    expect(refusal(read(fields)).message).toBe(NAMES_REQUIRED);
  });

  test.each(['{"vhost":"/","stream":"\\ud800"}', '{"vhost":"\\udc00x","stream":"orders"}'])(
    "a name holding a lone surrogate, which has no UTF-8 form: %s",
    (text) => {
      expect(refusal(text).message).toBe(NAMES_REQUIRED);
    },
  );

  test.each([
    ["10"],
    [-1],
    [null],
    [{ age: "0h" }],
    [{ age: "5w" }],
    [{ age: 5 }],
    [{ offset: 1, age: "1h" }],
    [{}],
    [["first"]],
    ["latest"],
    [{ timestamp: "2026-10-11T00:00:00Z", offset: 1 }],
  ])("a start outside the forms: %p", (from) => {
    expect(refusal(read({ from })).message).toBe(FROM_FORMS);
  });

  test.each([[-1], [1.5], [9007199254740992], ["-1"], ["1.5"], ["0x10"], [true]])(
    "an offset that is not a whole number in range: %p",
    (offset) => {
      expect(refusal(read({ from: { offset } })).message).toBe(OFFSET_NOT_WHOLE);
    },
  );

  test("an offset string past the signed 64-bit range", () => {
    expect(refusal(read({ from: { offset: "9223372036854775808" } })).message).toBe(OFFSET_TOO_LARGE);
  });

  test.each([
    "2026-10-11T08:30:00",
    "2026-10-11",
    "2026-10-11T08:30:00.1234Z",
    "yesterday",
    1792225800,
    "2026-13-01T00:00Z",
  ])("a timestamp outside the form: %p", (timestamp) => {
    expect(refusal(read({ from: { timestamp } })).message).toBe(TIMESTAMP_FORM);
  });

  test.each(["2026-02-29T00:00Z", "2026-04-31T00:00Z", "2026-01-00T00:00Z", "2100-02-29T00:00Z"])(
    "a day its month does not have: %s",
    (timestamp) => {
      expect(refusal(read({ from: { timestamp } })).message).toBe(TIMESTAMP_DAY);
    },
  );

  test("an instant before 1970", () => {
    expect(refusal(read({ from: { timestamp: "1969-12-31T23:59:59Z" } })).message).toBe(TIMESTAMP_BEFORE_EPOCH);
  });

  test.each([[0], [501], [1.5], ["50"], [null]])("a limit outside 1 to 500: %p", (limit) => {
    expect(refusal(read({ limit })).message).toBe(LIMIT_RANGE);
  });
});
