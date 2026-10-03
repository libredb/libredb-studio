/**
 * Driver values to JSON-safe values (Neo4j provider spec 3.4, revisions SR1, SR16 and SR18)
 *
 * Every value here is a real neo4j-driver-lite 6.2.0 value class, built the way the
 * driver builds them off the wire, so the conversion is pinned against the driver's
 * own predicates rather than against look-alike objects. The grid must receive
 * values with no precision loss: a 64-bit integer past 2^53 as its decimal string, a
 * zoned datetime with its nanoseconds and zone, NaN as text, and graph values in the
 * tagged forms of `values.ts`.
 */
import { describe, expect, test } from "bun:test";
import neo4j from "neo4j-driver-lite";
import { boundedJsonCell, MAX_CELL_DEPTH, MAX_CELL_JSON_BYTES, toJsonValue } from "@/lib/db/graph/bolt/record-values";
import { type GraphPathJson, isGraphValueJson } from "@/lib/db/graph/values";

const { Node, Relationship, Path, PathSegment, Point, Date: CypherDate, DateTime, Duration } = neo4j.types;

const alice = new Node(neo4j.int(1), ["Person"], { name: "Alice", age: neo4j.int(42) }, "4:db:1");
const bob = new Node(neo4j.int(2), ["Person", "Admin"], { name: "Bob" }, "4:db:2");
const carol = new Node(neo4j.int(3), ["Person"], {}, "4:db:3");
const knows = new Relationship(
  neo4j.int(10),
  neo4j.int(1),
  neo4j.int(2),
  "KNOWS",
  { since: neo4j.int(2020) },
  "5:db:10",
  "4:db:1",
  "4:db:2",
);
const likes = new Relationship(neo4j.int(11), neo4j.int(2), neo4j.int(3), "LIKES", {}, "5:db:11", "4:db:2", "4:db:3");

const aliceJson = {
  "~graph": "node",
  elementId: "4:db:1",
  labels: ["Person"],
  properties: { name: "Alice", age: 42 },
};
const bobJson = { "~graph": "node", elementId: "4:db:2", labels: ["Person", "Admin"], properties: { name: "Bob" } };
const carolJson = { "~graph": "node", elementId: "4:db:3", labels: ["Person"], properties: {} };
const knowsJson = {
  "~graph": "relationship",
  elementId: "5:db:10",
  type: "KNOWS",
  startNodeElementId: "4:db:1",
  endNodeElementId: "4:db:2",
  properties: { since: 2020 },
};
const likesJson = {
  "~graph": "relationship",
  elementId: "5:db:11",
  type: "LIKES",
  startNodeElementId: "4:db:2",
  endNodeElementId: "4:db:3",
  properties: {},
};

describe("scalars", () => {
  test("null and undefined are null", () => {
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue(undefined)).toBeNull();
  });

  test("strings and booleans are themselves", () => {
    expect(toJsonValue("text")).toBe("text");
    expect(toJsonValue(true)).toBe(true);
  });

  test("an Integer in the safe range is a number", () => {
    expect(toJsonValue(neo4j.int(42))).toBe(42);
    expect(toJsonValue(neo4j.int(-9007199254740991))).toBe(-9007199254740991);
  });

  test("an Integer past 2^53 is its exact decimal string", () => {
    expect(toJsonValue(neo4j.int("9223372036854775807"))).toBe("9223372036854775807");
    expect(toJsonValue(neo4j.int("-9223372036854775808"))).toBe("-9223372036854775808");
  });

  test("a bigint is a number when safe, else its decimal string", () => {
    expect(toJsonValue(BigInt(7))).toBe(7);
    expect(toJsonValue(BigInt("9223372036854775807"))).toBe("9223372036854775807");
    expect(toJsonValue(BigInt("-9007199254740993"))).toBe("-9007199254740993");
  });

  test("finite numbers stay numbers; NaN and the infinities become text", () => {
    expect(toJsonValue(1.5)).toBe(1.5);
    expect(toJsonValue(Number.NaN)).toBe("NaN");
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(toJsonValue(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
  });
});

describe("temporal values keep every digit", () => {
  test("a zoned DateTime with nanoseconds", () => {
    const value = new DateTime(2024, 3, 10, 10, 15, 30, 500000001, 10800, "Europe/Istanbul");
    expect(toJsonValue(value)).toBe("2024-03-10T10:15:30.500000001+03:00[Europe/Istanbul]");
  });

  test("Date, Time, LocalTime, LocalDateTime and Duration", () => {
    expect(toJsonValue(new CypherDate(2024, 3, 10))).toBe("2024-03-10");
    expect(toJsonValue(new neo4j.types.Time(1, 2, 3, 4, 3600))).toBe("01:02:03.000000004+01:00");
    expect(toJsonValue(new neo4j.types.LocalTime(1, 2, 3, 4))).toBe("01:02:03.000000004");
    expect(toJsonValue(new neo4j.types.LocalDateTime(2024, 1, 2, 3, 4, 5, 6))).toBe("2024-01-02T03:04:05.000000006");
    expect(toJsonValue(new Duration(14, 3, 14706, 789000000))).toBe("P1Y2M3DT4H5M6.789000000S");
  });
});

describe("points", () => {
  test("a 2D point is srid, x and y, srid converted as an Integer", () => {
    expect(toJsonValue(new Point(neo4j.int(7203), 1, 2))).toEqual({ srid: 7203, x: 1, y: 2 });
  });

  test("a 3D point carries z", () => {
    expect(toJsonValue(new Point(neo4j.int(4979), 12.5, 41.9, 300))).toEqual({ srid: 4979, x: 12.5, y: 41.9, z: 300 });
  });

  test("a non-finite coordinate becomes text", () => {
    expect(toJsonValue(new Point(neo4j.int(7203), Number.NaN, 2))).toEqual({ srid: 7203, x: "NaN", y: 2 });
  });
});

describe("byte arrays and typed arrays", () => {
  test("an Int8Array is its unsigned bytes", () => {
    expect(toJsonValue(new Int8Array([0, 1, -1, -128, 127]))).toEqual([0, 1, 255, 128, 127]);
  });

  test("a Uint8Array is its bytes", () => {
    expect(toJsonValue(new Uint8Array([0, 200, 255]))).toEqual([0, 200, 255]);
  });

  test("other typed arrays are their converted elements", () => {
    expect(toJsonValue(new Float32Array([1.5, Number.NaN]))).toEqual([1.5, "NaN"]);
    expect(toJsonValue(new BigInt64Array([BigInt(1), BigInt("9223372036854775807")]))).toEqual([
      1,
      "9223372036854775807",
    ]);
  });
});

describe("graph values", () => {
  test("a node is the tagged node form with converted properties", () => {
    const json = toJsonValue(alice);
    expect(json).toEqual(aliceJson);
    expect(isGraphValueJson(json)).toBe(true);
  });

  test("a relationship is the tagged relationship form", () => {
    const json = toJsonValue(knows);
    expect(json).toEqual(knowsJson);
    expect(isGraphValueJson(json)).toBe(true);
  });

  test("a two-segment path is its nodes in order and its relationships", () => {
    const path = new Path(alice, carol, [new PathSegment(alice, knows, bob), new PathSegment(bob, likes, carol)]);
    const json = toJsonValue(path) as GraphPathJson;
    expect(json).toEqual({
      "~graph": "path",
      nodes: [aliceJson, bobJson, carolJson],
      relationships: [knowsJson, likesJson],
    } as unknown as GraphPathJson);
    expect(isGraphValueJson(json)).toBe(true);
  });

  test("a zero-length path is its start node and no relationship", () => {
    expect(toJsonValue(new Path(alice, alice, []))).toEqual({
      "~graph": "path",
      nodes: [aliceJson],
      relationships: [],
    });
  });
});

describe("other driver classes", () => {
  test("a UUID is its text", () => {
    expect(toJsonValue(neo4j.uuid("123e4567-e89b-12d3-a456-426614174000"))).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  test("a Vector is its text, not its backing array", () => {
    expect(toJsonValue(new neo4j.Vector(new Float32Array([1, 2, 3])))).toBe("vector([1, 2, 3], 3, FLOAT32 NOT NULL)");
  });

  test("an unbound relationship, or any other class instance, is its text", () => {
    const unbound = new neo4j.types.UnboundRelationship(neo4j.int(5), "T", {}, "5:db:5");
    expect(toJsonValue(unbound)).toBe(unbound.toString());
    class Opaque {
      toString() {
        return "opaque";
      }
    }
    expect(toJsonValue(new Opaque())).toBe("opaque");
  });
});

describe("collections", () => {
  test("a nested list of maps of Integers", () => {
    const value = [{ a: neo4j.int(1), b: [neo4j.int("9223372036854775807"), null] }, [{ c: neo4j.int(-3) }]];
    expect(toJsonValue(value)).toEqual([{ a: 1, b: ["9223372036854775807", null] }, [{ c: -3 }]]);
  });

  test("a plain array of numbers stays an array", () => {
    expect(toJsonValue([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("a map with a null prototype is converted like any map", () => {
    const map = Object.create(null) as Record<string, unknown>;
    map.n = neo4j.int(5);
    expect(toJsonValue(map)).toEqual({ n: 5 });
  });

  test("a key named __proto__ stays a key of the map, not its prototype", () => {
    const json = toJsonValue(JSON.parse('{"__proto__": {"x": 1}, "a": 2}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(Object.keys(json)).toEqual(["__proto__", "a"]);
    expect(JSON.stringify(json)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  test("a node property named __proto__ stays a property", () => {
    const odd = new Node(neo4j.int(4), ["Odd"], JSON.parse('{"__proto__": 1}'), "4:db:4");
    const json = toJsonValue(odd) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).toEqual(["__proto__"]);
    expect(JSON.stringify(json.properties)).toBe('{"__proto__":1}');
  });

  test("every converted value serialises without loss", () => {
    const value = { big: neo4j.int("9223372036854775807"), nan: Number.NaN, node: alice };
    expect(JSON.parse(JSON.stringify(toJsonValue(value)))).toEqual({
      big: "9223372036854775807",
      nan: "NaN",
      node: aliceJson,
    });
  });
});

describe("cell bound (SR16)", () => {
  function nested(depth: number): unknown {
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  }

  test("the bounds are 1 MiB and 32 levels", () => {
    expect(MAX_CELL_JSON_BYTES).toBe(1048576);
    expect(MAX_CELL_DEPTH).toBe(32);
  });

  test("a cell within the bounds is its converted value", () => {
    expect(boundedJsonCell(neo4j.int(1))).toEqual({ value: 1 });
    expect(boundedJsonCell(nested(MAX_CELL_DEPTH))).toEqual({ value: nested(MAX_CELL_DEPTH) });
  });

  test("a cell nested deeper than 32 levels is replaced", () => {
    expect(boundedJsonCell(nested(MAX_CELL_DEPTH + 1))).toEqual({
      value: "<value nested too deeply>",
      replaced: "depth",
    });
  });

  test("depth counts maps and graph forms too", () => {
    let value: unknown = alice;
    for (let i = 0; i < MAX_CELL_DEPTH - 1; i++) value = { v: value };
    expect(boundedJsonCell(value).replaced).toBe("depth");
  });

  /** `value` inside `lists` single-element lists. */
  function wrap(value: unknown, lists: number): unknown {
    let out = value;
    for (let i = 0; i < lists; i++) out = [out];
    return out;
  }

  /** The nesting depth of a JSON value: 0 for a scalar, 1 for a flat list or map. */
  function jsonDepth(value: unknown): number {
    if (value === null || typeof value !== "object") return 0;
    const children = Array.isArray(value) ? value : Object.values(value);
    return 1 + children.reduce<number>((deepest, child) => Math.max(deepest, jsonDepth(child)), 0);
  }

  // Each value opens this many levels of its own: a point and a byte array one (the
  // object or the list), a node and a relationship two (the object and its properties),
  // a path four (the object, its node and relationship lists, the members, their properties).
  test.each([
    ["a point", new Point(neo4j.int(7203), 1, 2), 1],
    ["a byte array", new Uint8Array([1, 2]), 1],
    ["a signed byte array", new Int8Array([-1]), 1],
    ["a node", alice, 2],
    ["a relationship", knows, 2],
    ["a path", new Path(alice, bob, [new PathSegment(alice, knows, bob)]), 4],
    ["a zero-length path", new Path(alice, alice, []), 4],
  ] as const)("%s exactly at the depth bound is kept, one level deeper is replaced", (_, value, levels) => {
    const fits = boundedJsonCell(wrap(value, MAX_CELL_DEPTH - levels));
    expect(fits.replaced).toBeUndefined();
    expect(jsonDepth(fits.value)).toBe(MAX_CELL_DEPTH);
    expect(boundedJsonCell(wrap(value, MAX_CELL_DEPTH - levels + 1))).toEqual({
      value: "<value nested too deeply>",
      replaced: "depth",
    });
  });

  test("a cell over 1 MiB of JSON is replaced, naming its size", () => {
    const text = "x".repeat(MAX_CELL_JSON_BYTES);
    const cell = boundedJsonCell(text);
    expect(cell).toEqual({ value: `<value too large: ${MAX_CELL_JSON_BYTES + 2} bytes>`, replaced: "size" });
  });

  test("the size is counted in UTF-8 bytes", () => {
    const text = "é".repeat(MAX_CELL_JSON_BYTES / 2);
    expect(boundedJsonCell(text).replaced).toBe("size");
  });

  test("conversion cost of a 10,000-element list", () => {
    const list = Array.from({ length: 10000 }, (_, i) => ({ id: neo4j.int(i), at: new CypherDate(2024, 1, 1) }));
    const started = performance.now();
    const cell = boundedJsonCell(list);
    const elapsed = performance.now() - started;
    expect(cell.replaced).toBeUndefined();
    expect((cell.value as unknown[]).length).toBe(10000);
    console.log(`boundedJsonCell over 10,000 maps of an Integer and a Date: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
