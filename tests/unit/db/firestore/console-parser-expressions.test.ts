/**
 * The console's value expressions: numbers by their source text, strings, arrays and maps, the typed constructors
 * with their ranges, the date rule that never reads the server's time zone, field paths, filters and aggregations.
 */
import { describe, expect, test } from "bun:test";
import { LEXER_SENTENCES, lex } from "@/lib/db/providers/document/firestore/console/lexer";
import {
  aggregateOf,
  fieldRefOf,
  filterOf,
  literalOf,
  PARSER_SENTENCES,
  parseDateText,
  parseExpressionText,
  Reader,
} from "@/lib/db/providers/document/firestore/console/parser";
import { FIELD_PATH_SENTENCES } from "@/lib/db/providers/document/firestore/field-path";
import { refusal } from "../../../helpers/firestore-console";

const literal = (source: string) => literalOf(parseExpressionText(source), source);
const field = (source: string) => fieldRefOf(parseExpressionText(source), source);
const filter = (source: string) => filterOf(parseExpressionText(source), source);
const aggregate = (source: string) => aggregateOf(parseExpressionText(source), source);
const refused = (run: () => unknown, sentence: string, position: number): void => {
  const error = refusal(run);
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};

describe("numbers keep their source text", () => {
  test("an integral literal is an integer, sent as its decimal string, within 64 bits", () => {
    expect(literal("42")).toEqual({ kind: "integer", text: "42" });
    expect(literal("-0")).toEqual({ kind: "integer", text: "0" });
    expect(literal("- 5")).toEqual({ kind: "integer", text: "-5" });
    expect(literal("9223372036854775807")).toEqual({ kind: "integer", text: "9223372036854775807" });
    expect(literal("-9223372036854775808")).toEqual({ kind: "integer", text: "-9223372036854775808" });
    refused(() => literal("9223372036854775808"), PARSER_SENTENCES.integerRange, 0);
    refused(() => literal("-9223372036854775809"), PARSER_SENTENCES.integerRange, 0);
  });

  test("a fraction or an exponent makes a double, as the SDK does not", () => {
    expect(literal("1.0")).toEqual({ kind: "double", value: 1 });
    expect(literal("1e3")).toEqual({ kind: "double", value: 1000 });
    expect(literal("-2.5E-1")).toEqual({ kind: "double", value: -0.25 });
    refused(() => literal("1e400"), PARSER_SENTENCES.doubleRange, 0);
  });

  test("NaN and the infinities are doubles; a minus goes only before a number or Infinity", () => {
    expect(literal("NaN")).toEqual({ kind: "double", value: "NaN" });
    expect(literal("Infinity")).toEqual({ kind: "double", value: "Infinity" });
    expect(literal("-Infinity")).toEqual({ kind: "double", value: "-Infinity" });
    refused(() => literal("-NaN"), PARSER_SENTENCES.minus, 0);
  });
});

describe("chain sentences", () => {
  test("the call-placement sentences name the call and what it may follow", () => {
    expect(PARSER_SENTENCES.notOn("limit", "a document", "get()")).toBe(
      "limit() cannot be called on a document; it takes get()",
    );
    expect(PARSER_SENTENCES.afterCursor("where")).toBe(
      "where() cannot follow startAt(), startAfter(), endAt() or endBefore(); move it before the cursor",
    );
  });
});

describe("plain values", () => {
  test("the reader looks ahead without consuming, and stops at eof", () => {
    const reader = new Reader("db.x", lex("db.x"));
    expect([reader.isIdent("db"), reader.isPunct(".", 1), reader.isIdent("x", 2), reader.peek(9).kind]).toEqual([
      true,
      true,
      true,
      "eof",
    ]);
  });

  test("booleans, null, strings, arrays and maps, trailing commas included", () => {
    expect(literal("true")).toEqual({ kind: "boolean", value: true });
    expect(literal("false")).toEqual({ kind: "boolean", value: false });
    expect(literal("null")).toEqual({ kind: "null" });
    expect(literal("'it\\'s'")).toEqual({ kind: "string", value: "it's" });
    expect(literal("[1, 'a', [true],]")).toEqual({
      kind: "array",
      items: [
        { kind: "integer", text: "1" },
        { kind: "string", value: "a" },
        { kind: "array", items: [{ kind: "boolean", value: true }] },
      ],
    });
    expect(literal("{ a: 1, 'b c': null, }")).toEqual({
      kind: "map",
      entries: [
        ["a", { kind: "integer", text: "1" }],
        ["b c", { kind: "null" }],
      ],
    });
  });

  test("a repeated key, a number key and a stray token are refused where they stand", () => {
    refused(() => literal("{ a: 1, a: 2 }"), PARSER_SENTENCES.duplicateKey("a"), 8);
    refused(() => literal("{ 1: 2 }"), PARSER_SENTENCES.objectKey, 2);
    refused(() => literal("1 2"), PARSER_SENTENCES.expected("the end of the value"), 2);
    refused(() => literal("[1 2]"), PARSER_SENTENCES.expected('"," or "]"'), 3);
    refused(() => literal(")"), PARSER_SENTENCES.expected("a value"), 0);
    refused(() => literal("{ a 1 }"), PARSER_SENTENCES.expected('":"'), 4);
    refused(() => literal("new 5"), PARSER_SENTENCES.expected("a name"), 4);
  });

  test("a variable, an unknown call and a write sentinel are refused, never evaluated", () => {
    refused(() => literal("x"), PARSER_SENTENCES.variable("x"), 0);
    refused(() => literal("Math.max(1)"), PARSER_SENTENCES.notAValue("Math.max"), 0);
    refused(() => literal("new Foo()"), PARSER_SENTENCES.notAValue("new Foo"), 0);
    refused(
      () => literal("FieldValue.serverTimestamp()"),
      PARSER_SENTENCES.writeValue("FieldValue.serverTimestamp"),
      0,
    );
    refused(
      () => literal("admin.firestore.FieldValue.increment(1)"),
      PARSER_SENTENCES.writeValue("FieldValue.increment"),
      0,
    );
    refused(() => literal("`a${b}`"), LEXER_SENTENCES.placeholder, 2);
  });
});

describe("timestamps", () => {
  test("fromDate takes an RFC 3339 date-time with a zone, or a date read as UTC midnight", () => {
    expect(literal('Timestamp.fromDate(new Date("2026-10-12"))')).toEqual({
      kind: "timestamp",
      seconds: "1791763200",
      nanos: 0,
    });
    expect(literal('Timestamp.fromDate(new Date("2026-10-12T09:30:00+03:00"))')).toEqual({
      kind: "timestamp",
      seconds: "1791786600",
      nanos: 0,
    });
    expect(literal('admin.firestore.Timestamp.fromDate(new Date("2024-02-29T23:59:59.987654Z"))')).toEqual({
      kind: "timestamp",
      seconds: "1709251199",
      nanos: 987_000_000,
    });
  });

  test.each([
    "2026-10-12T09:30:00",
    "2026-02-30",
    "2026-13-01",
    "2026-10-12 09:30:00Z",
    "2026-10-12T24:00:00Z",
    "2026-10-12T09:30:00+24:00",
    "October 12, 2026",
    "0000-01-01",
    "2026-10-12T09:60:00Z",
    "2026-10-12T09:30:60Z",
    "2026-10-12T09:30:00+01:60",
    "2026-00-12",
    "2026-10-00",
  ])("fromDate refuses %j at the string", (date) => {
    refused(() => literal(`Timestamp.fromDate(new Date(${JSON.stringify(date)}))`), PARSER_SENTENCES.dateText, 28);
  });

  test("fromDate needs new Date with one string, and the instant must fit 0001 to 9999", () => {
    refused(() => literal('Timestamp.fromDate("2026-10-12")'), PARSER_SENTENCES.dateCall, 19);
    refused(() => literal("Timestamp.fromDate(new Date(0))"), PARSER_SENTENCES.dateCall, 19);
    refused(
      () => literal('Timestamp.fromDate(new Date("9999-12-31T23:59:59-01:00"))'),
      PARSER_SENTENCES.timestampRange,
      0,
    );
  });

  test("leap days follow the Gregorian rule", () => {
    expect(parseDateText("2026-10-12")).toEqual({ seconds: BigInt(1_791_763_200), nanos: 0 });
    expect(parseDateText("2000-02-29")).not.toBeNull();
    expect(parseDateText("2023-02-29")).toBeNull();
    expect(parseDateText("1900-02-29")).toBeNull();
  });

  test("the same text gives the same instant under two server time zones", () => {
    const before = process.env.TZ;
    const source = 'Timestamp.fromDate(new Date("2026-10-12"))';
    const offsets: number[] = [];
    const answers: unknown[] = [];
    try {
      for (const zone of ["America/Los_Angeles", "Asia/Kolkata"]) {
        process.env.TZ = zone;
        offsets.push(new Date(2026, 9, 12).getTimezoneOffset());
        answers.push(literal(source));
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
    // The control: the zone really changed between the two readings.
    expect(offsets[0]).not.toBe(offsets[1]);
    expect(answers[0]).toEqual({ kind: "timestamp", seconds: "1791763200", nanos: 0 });
    expect(answers[1]).toEqual(answers[0]);
  });

  test("fromMillis takes an integer and floors toward the past", () => {
    expect(literal("Timestamp.fromMillis(-500)")).toEqual({ kind: "timestamp", seconds: "-1", nanos: 500_000_000 });
    expect(literal("Timestamp.fromMillis(1791763200123)")).toEqual({
      kind: "timestamp",
      seconds: "1791763200",
      nanos: 123_000_000,
    });
    refused(() => literal("Timestamp.fromMillis(1.5)"), PARSER_SENTENCES.integerExpected("Timestamp.fromMillis()"), 21);
  });

  test("new Timestamp takes seconds and nanos within their ranges", () => {
    expect(literal("new Timestamp(1, 999999999)")).toEqual({ kind: "timestamp", seconds: "1", nanos: 999_999_999 });
    expect(literal("new Timestamp(253402300799, 999999999)")).toMatchObject({ seconds: "253402300799" });
    refused(() => literal("new Timestamp(1, 1000000000)"), PARSER_SENTENCES.nanosRange, 17);
    refused(() => literal("new Timestamp(1, -1)"), PARSER_SENTENCES.nanosRange, 17);
    expect(literal("new Timestamp(-62135596800, 0)")).toMatchObject({ seconds: "-62135596800" });
    refused(() => literal("new Timestamp(-62135596801, 0)"), PARSER_SENTENCES.timestampRange, 0);
    refused(() => literal("new Timestamp(1)"), PARSER_SENTENCES.arguments("new Timestamp()", "exactly 2 arguments"), 0);
  });
});

describe("geopoints, vectors and references", () => {
  test("a geopoint takes latitude -90 to 90 and longitude -180 to 180", () => {
    expect(literal("new GeoPoint(-90, 180)")).toEqual({ kind: "geopoint", latitude: -90, longitude: 180 });
    expect(literal("new GeoPoint(90, -180)")).toEqual({ kind: "geopoint", latitude: 90, longitude: -180 });
    expect(literal("new admin.firestore.GeoPoint(1, 2.5)")).toEqual({ kind: "geopoint", latitude: 1, longitude: 2.5 });
    refused(() => literal("new GeoPoint(90.5, 0)"), PARSER_SENTENCES.latitude, 13);
    refused(() => literal("new GeoPoint(0, -180.1)"), PARSER_SENTENCES.longitude, 16);
    refused(() => literal('new GeoPoint("1", 2)'), PARSER_SENTENCES.numberExpected("new GeoPoint()"), 13);
  });

  test("a vector holds at most 2,048 finite numbers", () => {
    expect(literal("FieldValue.vector([1, 2.5, -3])")).toEqual({ kind: "vector", values: [1, 2.5, -3] });
    refused(() => literal('FieldValue.vector(["a"])'), PARSER_SENTENCES.vectorElements, 19);
    refused(() => literal("FieldValue.vector([NaN])"), PARSER_SENTENCES.vectorElements, 19);
    refused(() => literal("FieldValue.vector(1)"), PARSER_SENTENCES.vectorElements, 18);
    expect(literal(`FieldValue.vector([${"1,".repeat(2_048)}])`)).toMatchObject({ kind: "vector" });
    refused(() => literal(`FieldValue.vector([${"1,".repeat(2_049)}])`), PARSER_SENTENCES.vectorSize, 18);
  });

  test("db.doc() is a reference to an even-segment path", () => {
    expect(literal('db.doc("users/alice")')).toEqual({ kind: "reference", segments: ["users", "alice"] });
    refused(() => literal('db.doc("users")'), PARSER_SENTENCES.referencePath, 7);
    expect(refusal(() => literal('db.doc("users//x")')).position).toBe(7);
  });
});

describe("field paths", () => {
  test("a dotted string, new FieldPath and FieldPath.documentId()", () => {
    expect(field('"address.city"')).toEqual({ path: ["address", "city"], at: 0 });
    expect(field('new FieldPath("a.b", "c")')).toEqual({ path: ["a.b", "c"], at: 0 });
    expect(field("FieldPath.documentId()")).toEqual({ path: ["__name__"], at: 0 });
    expect(field("admin.firestore.FieldPath.documentId()").path).toEqual(["__name__"]);
  });

  test("a bad path, an empty segment and a non-path are refused where they stand", () => {
    expect(refusal(() => field('"a..b"')).position).toBe(0);
    refused(() => field('new FieldPath("")'), PARSER_SENTENCES.fieldSegment, 14);
    refused(() => field("new FieldPath()"), PARSER_SENTENCES.fieldSegment, 0);
    refused(() => field('new FieldPath("a", "\\uD800")'), FIELD_PATH_SENTENCES.malformed, 0);
    refused(() => field("42"), PARSER_SENTENCES.fieldPath, 0);
    refused(
      () => field("FieldPath.documentId(1)"),
      PARSER_SENTENCES.arguments("FieldPath.documentId()", "no arguments"),
      0,
    );
  });
});

describe("filters", () => {
  test("Filter.where reads = as ==, and Filter.and and Filter.or nest", () => {
    expect(filter('Filter.where("age", "=", 21)')).toEqual({
      kind: "compare",
      field: { path: ["age"], at: 13 },
      op: "==",
      value: { kind: "integer", text: "21" },
      at: 0,
    });
    expect(filter('Filter.or(Filter.where("a", "==", 1), Filter.and(Filter.where("b", "<", 2)))')).toMatchObject({
      kind: "or",
      filters: [
        { kind: "compare", op: "==" },
        { kind: "and", filters: [{ kind: "compare", op: "<" }] },
      ],
      at: 0,
    });
  });

  test.each(["<", "<=", "==", "!=", ">=", ">", "array-contains", "in", "not-in", "array-contains-any"])(
    "the operator %s is read as itself",
    (op) => {
      expect(filter(`Filter.where("a", ${JSON.stringify(op)}, 1)`)).toMatchObject({ op });
    },
  );

  test("an unknown operator and a non-filter are refused", () => {
    refused(() => filter('Filter.where("a", "~", 1)'), PARSER_SENTENCES.operator("~"), 18);
    refused(() => filter('Filter.where("a", 5, 1)'), PARSER_SENTENCES.operator(undefined), 18);
    refused(() => filter("Filter.not(1)"), PARSER_SENTENCES.filter, 0);
    refused(() => filter("Filter.and()"), PARSER_SENTENCES.filter, 0);
  });
});

describe("aggregations", () => {
  test("count, sum and average", () => {
    expect(aggregate("AggregateField.count()")).toEqual({ op: "count" });
    expect(aggregate('AggregateField.sum("price")')).toEqual({ op: "sum", field: { path: ["price"], at: 19 } });
    expect(aggregate('admin.firestore.AggregateField.average(new FieldPath("a"))')).toMatchObject({
      op: "avg",
      field: { path: ["a"] },
    });
  });

  test("any other aggregation is refused", () => {
    refused(() => aggregate('AggregateField.min("x")'), PARSER_SENTENCES.aggregateField, 0);
    refused(
      () => aggregate("AggregateField.count(1)"),
      PARSER_SENTENCES.arguments("AggregateField.count()", "no arguments"),
      0,
    );
  });
});
