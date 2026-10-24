/**
 * The where filter of a Weaviate search or aggregate (#1566 spec 5.3, W4): every level is closed, And and Or take
 * operands and Not exactly one, every other operator a path and exactly one value key of the right kind, and the
 * whole filter is bounded at 256 conditions, 8 levels and 64 KiB. Each rule is read in phase 0 with no call.
 */
import { describe, expect, test } from "bun:test";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { refused, searchOf } from "../../../helpers/weaviate-request-fixtures";

const search = (where: string) => `POST /v1/search/Article/bm25 {"query": "x", "where": ${where}}`;
const refusedWhere = (where: string) => refused(search(where));
const condition = (extra: string) => `{"path": ["category"], "operator": "Equal", ${extra}}`;
const nested = (depth: number): string =>
  depth === 1 ? condition('"valueText": "a"') : `{"operator": "And", "operands": [${nested(depth - 1)}]}`;

describe("an accepted filter", () => {
  test("is handed on exactly as written", () => {
    const where =
      '{"operator": "And", "operands": [{"path": ["category"], "operator": "Equal", "valueText": "alpha"}, {"operator": "Not", "operands": [{"path": ["wordCount"], "operator": "GreaterThan", "valueInt": 100}]}]}';
    expect(toJsonText(searchOf(search(where)).where as never)).toBe(
      '{"operator":"And","operands":[{"path":["category"],"operator":"Equal","valueText":"alpha"},{"operator":"Not","operands":[{"path":["wordCount"],"operator":"GreaterThan","valueInt":100}]}]}',
    );
  });

  test.each([
    ['"valueNumber": 1.5'],
    ['"valueNumber": 2'],
    ['"valueBoolean": true'],
    ['"valueString": "a"'],
    ['"valueDate": "2026-01-01T00:00:00Z"'],
    ['"valueTextArray": ["a", "b"]'],
    ['"valueIntArray": [1, 2]'],
    ['"valueNumberArray": [1.5]'],
    ['"valueBooleanArray": [false]'],
    ['"valueStringArray": ["a"]'],
    ['"valueDateArray": ["2026-01-01T00:00:00Z"]'],
  ])("takes %s", (value) => {
    expect(searchOf(search(condition(value))).where).not.toBeNull();
  });

  test("a path through a cross-reference names the property, the class, then its property", () => {
    expect(
      searchOf(search('{"path": ["writtenBy", "Author", "name"], "operator": "Like", "valueText": "A*"}')).where,
    ).not.toBeNull();
  });

  test("IsNull takes valueBoolean", () => {
    expect(searchOf(search('{"path": ["category"], "operator": "IsNull", "valueBoolean": true}')).where).not.toBeNull();
  });

  test("a geo range at the edges of the globe opens", () => {
    const where =
      '{"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": -90, "longitude": 180}, "distance": {"max": 0}}}';
    expect(searchOf(search(where)).where).not.toBeNull();
  });

  test("8 levels and 256 conditions open", () => {
    expect(searchOf(search(nested(8))).where).not.toBeNull();
    const operands = new Array(255).fill(condition('"valueText": "a"')).join(",");
    expect(searchOf(search(`{"operator": "Or", "operands": [${operands}]}`)).where).not.toBeNull();
  });
});

describe("a refused filter", () => {
  test("must be an object", () => {
    expect(refusedWhere("[]")).toEqual({ phase: 0, key: "where", message: "where must be an object, found a list." });
  });

  test("takes only the where filter's keys", () => {
    expect(refusedWhere('{"operator": "Equal", "path": ["a"], "valueText": "a", "value": 1}')).toEqual({
      phase: 0,
      key: "value",
      message:
        'where takes no key "value": Weaviate reads operator, operands, path, valueInt, valueNumber, valueBoolean, valueString, valueText, valueDate, valueIntArray, valueNumberArray, valueBooleanArray, valueStringArray, valueTextArray, valueDateArray, valueGeoRange there and nothing else.',
    });
  });

  test("needs an operator, one of Weaviate's words", () => {
    expect(refusedWhere('{"path": ["a"], "valueText": "a"}').message).toBe("where needs the key operator.");
    expect(refusedWhere('{"path": ["a"], "operator": "Equals", "valueText": "a"}')).toEqual({
      phase: 0,
      key: "where.operator",
      message:
        'where.operator takes one of And, Or, Not, Equal, NotEqual, Like, GreaterThan, GreaterThanEqual, LessThan, LessThanEqual, WithinGeoRange, IsNull, ContainsAny, ContainsAll, ContainsNone, not "Equals".',
    });
  });

  test("And, Or and Not take operands only, at least one, and Not exactly one", () => {
    expect(refusedWhere('{"operator": "And", "path": ["a"], "operands": []}')).toEqual({
      phase: 0,
      key: "where",
      message: "where: And takes operands only, never a path or a value.",
    });
    expect(refusedWhere('{"operator": "Or", "valueText": "a", "operands": []}').message).toBe(
      "where: Or takes operands only, never a path or a value.",
    );
    expect(refusedWhere('{"operator": "And"}').message).toBe("where.operands must be a list, found nothing.");
    expect(refusedWhere('{"operator": "And", "operands": []}').message).toBe(
      "where.operands: And needs at least one operand.",
    );
    const two = `${condition('"valueText": "a"')}, ${condition('"valueText": "b"')}`;
    expect(refusedWhere(`{"operator": "Not", "operands": [${two}]}`).message).toBe(
      "where.operands: Not takes exactly one operand.",
    );
  });

  test("an operand is read at its own place in the filter", () => {
    expect(
      refusedWhere('{"operator": "And", "operands": [{"operator": "Equal", "path": [], "valueText": "a"}]}'),
    ).toEqual({ phase: 0, key: "where.operands[0]", message: "where.operands[0].path names no property." });
  });

  test("a comparison takes a path and a value, never operands", () => {
    expect(refusedWhere('{"operator": "Equal", "path": ["a"], "valueText": "a", "operands": []}').message).toBe(
      "where: Equal takes a path and a value, never operands.",
    );
    expect(refusedWhere('{"operator": "Equal", "valueText": "a"}').message).toBe(
      "where.path must be a list, found nothing.",
    );
    expect(refusedWhere('{"operator": "Equal", "path": [1], "valueText": "a"}').message).toBe(
      "where.path[0] must be a string, found a number.",
    );
    expect(refusedWhere('{"operator": "Equal", "path": ["a b"], "valueText": "a"}').message).toBe(
      'where.path[0] is "a b", which is not a property or class name.',
    );
  });

  test("a comparison takes exactly one value key", () => {
    expect(refusedWhere('{"operator": "Equal", "path": ["a"]}').message).toBe(
      "where: Equal takes exactly one value key (valueText, valueInt and the rest), found 0.",
    );
    expect(refusedWhere(condition('"valueText": "a", "valueInt": 1')).message).toBe(
      "where: Equal takes exactly one value key (valueText, valueInt and the rest), found 2.",
    );
  });

  test("a value key written as null is absent, as it is at the top level", () => {
    expect(searchOf(search(condition('"valueText": "alpha", "valueGeoRange": null'))).where).not.toBeNull();
  });

  test("WithinGeoRange and valueGeoRange go only together", () => {
    const sentence = "where: WithinGeoRange takes valueGeoRange, and valueGeoRange takes WithinGeoRange.";
    expect(refusedWhere('{"operator": "WithinGeoRange", "path": ["location"], "valueText": "a"}').message).toBe(
      sentence,
    );
    expect(refusedWhere(condition('"valueGeoRange": {}')).message).toBe(sentence);
  });

  test("IsNull takes valueBoolean only", () => {
    expect(refusedWhere('{"operator": "IsNull", "path": ["a"], "valueText": "a"}').message).toBe(
      "where: IsNull takes valueBoolean.",
    );
  });

  test.each([
    ['"valueInt": 1.5', "where.valueInt must be an integer, found a number."],
    [
      '"valueInt": 9007199254740992',
      "where.valueInt is 9007199254740992; it takes an integer from -9007199254740991 to 9007199254740991.",
    ],
    ['"valueNumber": "1"', "where.valueNumber must be a number, found a string."],
    ['"valueBoolean": "true"', "where.valueBoolean must be true or false, found a string."],
    ['"valueText": 1', "where.valueText must be a string, found a number."],
    ['"valueDate": false', "where.valueDate must be a string, found a boolean."],
    ['"valueTextArray": "a"', "where.valueTextArray must be a list, found a string."],
    ['"valueIntArray": [1, "2"]', "where.valueIntArray[1] must be an integer, found a string."],
  ])("a value of the wrong kind, %s, is refused", (value, message) => {
    expect(refusedWhere(condition(value)).message).toBe(message);
  });

  test("a value list holds at most 10,000 entries", () => {
    const entries = new Array(10_001).fill("1").join(",");
    expect(refusedWhere(condition(`"valueIntArray": [${entries}]`)).message).toBe(
      "where.valueIntArray holds 10001 entries, above 10000.",
    );
  });

  describe("a geo range", () => {
    const geo = (range: string) => `{"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": ${range}}`;

    test.each([
      ['"x"', "where.valueGeoRange must be an object, found a string."],
      ['{"geoCoordinates": {"latitude": 1, "longitude": 1}}', "where.valueGeoRange needs the key distance."],
      [
        '{"geoCoordinates": {"latitude": 1, "longitude": 1}, "distance": {"max": 1}, "radius": 1}',
        'where.valueGeoRange takes no key "radius": Weaviate reads geoCoordinates, distance there and nothing else.',
      ],
      [
        '{"geoCoordinates": [1, 1], "distance": {"max": 1}}',
        "where.valueGeoRange.geoCoordinates must be an object, found a list.",
      ],
      [
        '{"geoCoordinates": {"latitude": 1}, "distance": {"max": 1}}',
        "where.valueGeoRange.geoCoordinates needs the key longitude.",
      ],
      [
        '{"geoCoordinates": {"latitude": "1", "longitude": 1}, "distance": {"max": 1}}',
        "where.valueGeoRange.geoCoordinates.latitude must be a number, found a string.",
      ],
      [
        '{"geoCoordinates": {"latitude": 90.5, "longitude": 1}, "distance": {"max": 1}}',
        "where.valueGeoRange.geoCoordinates.latitude is outside -90 to 90.",
      ],
      [
        '{"geoCoordinates": {"latitude": 1, "longitude": -180.5}, "distance": {"max": 1}}',
        "where.valueGeoRange.geoCoordinates.longitude is outside -180 to 180.",
      ],
      [
        '{"geoCoordinates": {"latitude": 1, "longitude": 1}, "distance": 5}',
        "where.valueGeoRange.distance must be an object, found a number.",
      ],
      [
        '{"geoCoordinates": {"latitude": 1, "longitude": 1}, "distance": {"min": 1}}',
        'where.valueGeoRange.distance takes no key "min": Weaviate reads max there and nothing else.',
      ],
      [
        '{"geoCoordinates": {"latitude": 1, "longitude": 1}, "distance": {"max": -1}}',
        "where.valueGeoRange.distance.max cannot be negative.",
      ],
    ])("%s is refused", (range, message) => {
      expect(refusedWhere(geo(range)).message).toBe(message);
    });
  });

  test("deeper than 8 levels is refused", () => {
    expect(refusedWhere(nested(9))).toEqual({
      phase: 0,
      key: "where",
      message:
        "where.operands[0].operands[0].operands[0].operands[0].operands[0].operands[0].operands[0].operands[0] nests filters deeper than 8 levels.",
    });
  });

  test("more than 256 conditions is refused", () => {
    const operands = new Array(256).fill(condition('"valueText": "a"')).join(",");
    expect(refusedWhere(`{"operator": "Or", "operands": [${operands}]}`)).toEqual({
      phase: 0,
      key: "where",
      message: "The filter holds more than 256 conditions.",
    });
  });

  test("a filter above 64 KiB is refused before it is walked", () => {
    const where = condition(`"valueText": "${"a".repeat(65_536)}"`);
    expect(refusedWhere(where)).toEqual({
      phase: 0,
      key: "where",
      message: "The filter is 65591 bytes, above the bound of 65536.",
    });
  });
});
