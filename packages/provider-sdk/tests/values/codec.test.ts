import { describe, expect, test } from "bun:test";
import { decodeValue, encodeValue, MAX_VALUE_DEPTH, ValueCodecError } from "@libredb/provider-sdk/values";

/**
 * Studio's value codec, held by seeded property tests per tag.
 *
 * The generator is mulberry32 with fixed seeds, written here rather than taken from a
 * property-testing library: this file is its only user. Every assertion message names
 * the seed and the case, so a failure can be replayed by running that seed alone.
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [1, 7, 42, 2026, 0x5eed] as const;
const CASES_PER_SEED = 200;

type Random = () => number;

function int(random: Random, below: number): number {
  return Math.floor(random() * below);
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[int(random, items.length)];
}

const MIN_I64 = -(BigInt(2) ** BigInt(63));
const MAX_U64 = BigInt(2) ** BigInt(64) - BigInt(1);

function genBigInt(random: Random): bigint {
  const span = MAX_U64 - MIN_I64 + BigInt(1);
  let acc = BigInt(0);
  for (let i = 0; i < 3; i++) acc = (acc << BigInt(32)) | BigInt(int(random, 2 ** 32));
  return MIN_I64 + (acc % span);
}

function genBytes(random: Random, maxLength = 64): Uint8Array {
  const out = new Uint8Array(int(random, maxLength + 1));
  for (let i = 0; i < out.length; i++) out[i] = int(random, 256);
  return out;
}

const DATE_LIMIT = 8.64e15;

function genDate(random: Random): Date {
  return new Date(Math.round((random() * 2 - 1) * DATE_LIMIT));
}

function genString(random: Random): string {
  const units: number[] = [];
  const length = int(random, 12);
  for (let i = 0; i < length; i++) {
    units.push(
      pick(random, [
        () => int(random, 0x20),
        () => 0x20 + int(random, 0x5f),
        () => 0xd800 + int(random, 0x800),
        () => int(random, 0x10000),
      ])(),
    );
  }
  return String.fromCharCode(...units);
}

function genFinite(random: Random): number {
  return pick(random, [
    () => int(random, 1000) - 500,
    () => (random() - 0.5) * 1e300,
    () => random(),
    () => Number.MAX_VALUE,
    () => Number.MIN_VALUE,
  ])();
}

function genPlain(random: Random): unknown {
  return pick(random, [() => null, () => random() < 0.5, () => genString(random), () => genFinite(random)])();
}

type Leaf = (random: Random) => unknown;

const LEAVES: Record<string, Leaf> = {
  plain: genPlain,
  i64: genBigInt,
  bytes: (random) => (random() < 0.5 ? genBytes(random) : Buffer.from(genBytes(random))),
  ts: genDate,
  nf: (random) => pick(random, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
  obj: (random) => ({ $: genValue(random, 1, LEAVES.plain), v: genValue(random, 1, LEAVES.plain) }),
};

const KEYS = ["a", "$", "v", "__proto__", "i64", "x y", ""];
/** Keys that can never make an object whose keys are exactly `$` and `v`, the shape `obj` escapes. */
const KEYS_WITHOUT_V = KEYS.filter((key) => key !== "v");

/** A value nested in arrays and plain objects to a random depth, whose leaves come from `leaf`. */
function genValue(random: Random, depth: number, leaf: Leaf, keys: readonly string[] = KEYS): unknown {
  if (depth <= 0 || random() < 0.4) return leaf(random);
  if (random() < 0.5) {
    return Array.from({ length: int(random, 4) }, () => genValue(random, depth - 1, leaf, keys));
  }
  const entries: [string, unknown][] = [];
  for (let i = int(random, 4); i > 0; i--) entries.push([pick(random, keys), genValue(random, depth - 1, leaf, keys)]);
  return Object.fromEntries(entries);
}

function roundTrip(value: unknown): unknown {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
}

/** Compare a decoded value with the original: bytes by bytes, a Date by its time, -0 as 0. */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Uint8Array) {
    return (
      actual instanceof Uint8Array &&
      actual.length === expected.length &&
      actual.every((byte, index) => byte === expected[index])
    );
  }
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (typeof expected === "number") {
    if (Number.isNaN(expected)) return Number.isNaN(actual);
    return typeof actual === "number" && actual === expected && !Object.is(actual, -0);
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => sameValue(actual[index], item))
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    if (Object.getPrototypeOf(actual) !== Object.prototype) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(
        (key, index) =>
          actualKeys[index] === key &&
          sameValue((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]),
      )
    );
  }
  return actual === expected;
}

/** Run `check` on CASES_PER_SEED values of every seed, naming the seed and case on failure. */
function forEveryCase(
  leaf: Leaf,
  check: (value: unknown, label: string) => void,
  keys: readonly string[] = KEYS,
): void {
  for (const seed of SEEDS) {
    const random = mulberry32(seed);
    for (let n = 0; n < CASES_PER_SEED; n++) check(genValue(random, 4, leaf, keys), `seed ${seed}, case ${n}`);
  }
}

function expectRoundTrip(value: unknown, label: string): void {
  const out = roundTrip(value);
  if (!sameValue(out, value)) throw new Error(`${label}: the value did not round-trip`);
}

function refusal(run: () => unknown): ValueCodecError {
  try {
    run();
  } catch (error) {
    if (error instanceof ValueCodecError) return error;
    throw error;
  }
  throw new Error("expected a ValueCodecError, and nothing was thrown");
}

describe("plain JSON values", () => {
  test("a JSON value with no tagged kind passes through both ways unchanged", () => {
    forEveryCase(
      LEAVES.plain,
      (value, label) => {
        const encoded = encodeValue(value);
        expect(sameValue(encoded, value), label).toBe(true);
        expect(sameValue(decodeValue(encoded), value), label).toBe(true);
      },
      KEYS_WITHOUT_V,
    );
  });

  test("the encoded form of every generated value is plain JSON", () => {
    for (const [tag, leaf] of Object.entries(LEAVES)) {
      forEveryCase(leaf, (value, label) => {
        const encoded = encodeValue(value);
        expect(JSON.parse(JSON.stringify(encoded)), `${tag}, ${label}`).toEqual(encoded);
        expectRoundTrip(value, `${tag}, ${label}`);
      });
    }
  });
});

describe("i64", () => {
  test("every bigint from -2^63 to 2^64 - 1 round-trips as its decimal digits", () => {
    const two = BigInt(2);
    const edges = [
      MIN_I64,
      BigInt(-1),
      BigInt(0),
      two ** BigInt(53) + BigInt(1),
      two ** BigInt(63) - BigInt(1),
      MAX_U64,
    ];
    for (const value of edges) {
      expect(encodeValue(value)).toEqual({ $: "i64", v: value.toString() });
      expect(roundTrip(value)).toBe(value);
    }
    forEveryCase(LEAVES.i64, expectRoundTrip);
  });

  test("a bigint outside the 64-bit range is refused, naming its path", () => {
    const tooBig = BigInt(2) ** BigInt(64);
    const tooSmall = MIN_I64 - BigInt(1);
    expect(refusal(() => encodeValue(tooBig)).path).toBe("");
    const nested = refusal(() => encodeValue([{ k: tooSmall }]));
    expect(nested.path).toBe("/0/k");
    expect(nested.message).toContain("64-bit");
    expect(nested.message).not.toContain(tooSmall.toString());
  });

  test("digits with a plus sign, a leading zero, an exponent, spaces or -0 are refused on decode", () => {
    for (const digits of ["+1", "01", "-01", "1e3", " 1", "1 ", "-0", "", "-", "1.0", "0x10", "18446744073709551616"]) {
      expect(refusal(() => decodeValue({ $: "i64", v: digits })).path, digits).toBe("");
    }
    expect(refusal(() => decodeValue({ $: "i64", v: (MIN_I64 - BigInt(1)).toString() })).path).toBe("");
  });
});

describe("bytes", () => {
  test("every Uint8Array and Buffer round-trips as canonical base64, byte for byte", () => {
    for (const length of [0, 1, 2, 3]) expectRoundTrip(new Uint8Array(length).fill(0xab), `length ${length}`);
    const mebibyte = new Uint8Array(1024 * 1024);
    const random = mulberry32(11);
    for (let i = 0; i < mebibyte.length; i++) mebibyte[i] = int(random, 256);
    expectRoundTrip(mebibyte, "1 MiB");
    expectRoundTrip(Buffer.from(mebibyte.subarray(5, 1000)), "a Buffer over an offset slice");
    forEveryCase(LEAVES.bytes, expectRoundTrip);
  });

  test("a 16 MiB payload round-trips: validation is a linear scan, not a pattern an engine can give up on", () => {
    const bytes = new Uint8Array(16 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
    expectRoundTrip(bytes, "16 MiB");
  });

  test("the payload equals Node's own base64 for every length from 0 to 300", () => {
    const random = mulberry32(300);
    for (let length = 0; length <= 300; length++) {
      const filled = new Uint8Array(length);
      for (let i = 0; i < length; i++) filled[i] = int(random, 256);
      expect(encodeValue(filled), `length ${length}`).toEqual({
        $: "bytes",
        v: Buffer.from(filled).toString("base64"),
      });
    }
  });

  test("base64 that is malformed, unpadded, URL-safe or non-canonical is refused on decode", () => {
    for (const text of [
      "A",
      "AA",
      "AAA",
      "AA=",
      "A===",
      "AB==",
      "AAB=",
      "-_8=",
      "AA==AA==",
      "AA ==",
      "*AAA",
      "AA\n==",
    ]) {
      expect(refusal(() => decodeValue([{ $: "bytes", v: text }])).path, JSON.stringify(text)).toBe("/0");
    }
    expect(refusal(() => decodeValue({ $: "bytes", v: 12 })).path).toBe("");
  });

  test("decoded bytes are a plain Uint8Array", () => {
    const out = decodeValue({ $: "bytes", v: "3q2+7w==" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(out)).toBe(false);
    expect([...(out as Uint8Array)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("ts", () => {
  test("every valid Date round-trips as its toISOString text, the range ends included", () => {
    const ends: [Date, string][] = [
      [new Date(DATE_LIMIT), "+275760-09-13T00:00:00.000Z"],
      [new Date(-DATE_LIMIT), "-271821-04-20T00:00:00.000Z"],
    ];
    const yearZero = new Date(0);
    yearZero.setUTCFullYear(0, 0, 1);
    ends.push([yearZero, "0000-01-01T00:00:00.000Z"]);
    for (const [date, text] of ends) {
      expect(encodeValue(date)).toEqual({ $: "ts", v: text });
      expectRoundTrip(date, text);
    }
    forEveryCase(LEAVES.ts, expectRoundTrip);
  });

  test("an invalid Date is refused on encode", () => {
    const error = refusal(() => encodeValue({ when: new Date(Number.NaN) }));
    expect(error.path).toBe("/when");
    expect(error.message).toContain("invalid Date");
  });

  test("a timestamp that is not exactly toISOString's text is refused on decode", () => {
    for (const text of [
      "2026-11-22",
      "2026-11-22T10:00:00Z",
      "2026-11-22T10:00:00.000+00:00",
      "2026-11-22T10:00:00.000z",
      "2026-02-30T00:00:00.000Z",
      "+002026-11-22T10:00:00.000Z",
      "not a date",
    ]) {
      expect(refusal(() => decodeValue({ $: "ts", v: text })).path, text).toBe("");
    }
    expect(refusal(() => decodeValue({ $: "ts", v: 0 })).path).toBe("");
  });
});

describe("nf", () => {
  test("NaN, Infinity and -Infinity round-trip as their words", () => {
    expect(encodeValue(Number.NaN)).toEqual({ $: "nf", v: "NaN" });
    expect(encodeValue(Number.POSITIVE_INFINITY)).toEqual({ $: "nf", v: "Infinity" });
    expect(encodeValue(Number.NEGATIVE_INFINITY)).toEqual({ $: "nf", v: "-Infinity" });
    forEveryCase(LEAVES.nf, expectRoundTrip);
    for (const word of ["nan", "inf", "+Infinity", "Infinity "]) {
      expect(refusal(() => decodeValue({ $: "nf", v: word })).path, word).toBe("");
    }
  });

  test("a finite number stays a plain number, and -0 is written as 0", () => {
    expect(Object.is(encodeValue(-0), 0)).toBe(true);
    expect(encodeValue(1.5)).toBe(1.5);
    expect(encodeValue(Number.MAX_SAFE_INTEGER + 2)).toBe(Number.MAX_SAFE_INTEGER + 2);
  });
});

describe("obj", () => {
  test("an object whose keys are exactly $ and v round-trips at any depth and is never read as a tag", () => {
    const lookalikes = [
      { $: "i64", v: "9" },
      { $: "bytes", v: "AA==" },
      { $: "obj", v: { $: "nf", v: "NaN" } },
      { $: { $: "i64", v: BigInt(1) }, v: [{ $: "ts", v: new Date(0) }] },
      { v: 1, $: 2 },
    ];
    for (const value of lookalikes) {
      expectRoundTrip(
        value,
        JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)),
      );
      expectRoundTrip([[{ a: value }]], "nested");
    }
    expect(encodeValue({ $: "i64", v: "9" })).toEqual({ $: "obj", v: { $: "i64", v: "9" } });
    forEveryCase(LEAVES.obj, expectRoundTrip);
  });

  test("an object with $ alone or with a third key is not wrapped", () => {
    expect(encodeValue({ $: "i64" })).toEqual({ $: "i64" });
    expect(encodeValue({ $: "i64", v: "9", w: 1 })).toEqual({ $: "i64", v: "9", w: 1 });
    expect(decodeValue({ $: "i64", v: "9", w: 1 })).toEqual({ $: "i64", v: "9", w: 1 });
    expect(decodeValue({ $: "i64" })).toEqual({ $: "i64" });
  });

  test("an obj payload whose keys are not exactly $ and v is refused on decode", () => {
    for (const payload of [{ $: 1 }, { $: 1, v: 2, w: 3 }, [1, 2], "x", null]) {
      expect(refusal(() => decodeValue({ k: { $: "obj", v: payload } })).path).toBe("/k");
    }
  });

  test("a __proto__ key stays an own key", () => {
    const value = JSON.parse('{"__proto__": {"$": "i64", "v": "1"}, "a": 1}') as Record<string, unknown>;
    const out = roundTrip(value) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ $: "i64", v: "1" });
    const decoded = decodeValue(JSON.parse('{"__proto__": {"$": "i64", "v": "7"}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe(BigInt(7));
  });
});

describe("refusals", () => {
  class Point {
    constructor(readonly x: number) {}
  }
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const outOfDomain: [string, () => unknown, string][] = [
    ["undefined", () => undefined, "undefined"],
    ["a function", () => () => 1, "function"],
    ["a symbol", () => Symbol("s"), "symbol"],
    ["an invalid Date", () => new Date(Number.NaN), "invalid Date"],
    ["an Int16Array", () => new Int16Array(2), "Int16Array"],
    ["a Uint8ClampedArray", () => new Uint8ClampedArray(2), "Uint8ClampedArray"],
    ["a DataView", () => new DataView(new ArrayBuffer(2)), "DataView"],
    ["an ArrayBuffer", () => new ArrayBuffer(2), "ArrayBuffer"],
    ["a Map", () => new Map([["secret-key", "secret-value"]]), "Map"],
    ["a Set", () => new Set(["secret-value"]), "Set"],
    ["an Error", () => new Error("secret-value"), "Error"],
    ["a boxed string", () => Object("secret-value"), "boxed"],
    ["a boxed number", () => Object(12345), "boxed"],
    ["a class instance", () => new Point(12345), "Point"],
    ["an array with a hole", () => sparse, "hole"],
  ];

  test("every value outside the codec's domain is refused by kind, naming its JSON Pointer and never its value", () => {
    for (const [name, make, kind] of outOfDomain) {
      const atRoot = refusal(() => encodeValue(make()));
      expect(atRoot.path, name).toBe(name === "an array with a hole" ? "/1" : "");
      expect(atRoot.message, name).toContain(kind);
      // An object member whose value is undefined is left out (V-9), so undefined is nested as an array element.
      const nested =
        name === "undefined" ? refusal(() => encodeValue([[make()]])) : refusal(() => encodeValue([{ "k/~": make() }]));
      const nestedPath = name === "undefined" ? "/0/0" : name === "an array with a hole" ? "/0/k~1~0/1" : "/0/k~1~0";
      expect(nested.path, name).toBe(nestedPath);
      for (const message of [atRoot.message, nested.message]) {
        expect(message, name).not.toContain("secret-value");
        expect(message, name).not.toContain("12345");
      }
    }
  });

  test("an unknown tag or a payload of the wrong type is refused on decode, naming its path", () => {
    for (const wire of [
      { $: "dec", v: "1.5" },
      { $: "date", v: "2026-11-22" },
      { $: "time", v: "10:00" },
      { $: "dur", v: "PT1S" },
      { $: "", v: "" },
      { $: 1, v: 1 },
      { $: null, v: null },
      { $: "i64", v: 9 },
      { $: "nf", v: null },
    ]) {
      const error = refusal(() => decodeValue({ rows: [wire] }));
      expect(error.path, JSON.stringify(wire)).toBe("/rows/0");
    }
  });

  test("decode refuses a value JSON cannot produce", () => {
    for (const [name, value] of [
      ["Infinity", Number.POSITIVE_INFINITY],
      ["NaN", Number.NaN],
      ["a bigint", BigInt(1)],
      ["a Date", new Date(0)],
      ["undefined", undefined],
      ["a Uint8Array", new Uint8Array(1)],
      ["a function", () => 1],
      ["a symbol", Symbol("s")],
      ["a class instance", new Point(1)],
    ] as [string, unknown][]) {
      expect(refusal(() => decodeValue([value])).path, name).toBe("/0");
      expect(refusal(() => decodeValue({ a: value })).path, name).toBe("/a");
    }
    const sparseWire: unknown[] = [];
    sparseWire[1] = 1;
    expect(refusal(() => decodeValue(sparseWire)).path).toBe("/0");
  });

  test("a ValueCodecError is an Error with its own name", () => {
    const error = refusal(() => encodeValue(undefined));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ValueCodecError");
  });
});

/** `leaf` inside `depth` containers: arrays, or data objects under the key `a`. */
function nest(depth: number, leaf: unknown, container: "array" | "object"): unknown {
  let value = leaf;
  for (let level = 0; level < depth; level++) value = container === "array" ? [value] : { a: value };
  return value;
}

/** The JSON Pointer of the container `nest` puts inside `depth` others. */
function nestedPath(depth: number, container: "array" | "object"): string {
  return (container === "array" ? "/0" : "/a").repeat(depth);
}

const DEPTH_KIND = `a value nested deeper than ${MAX_VALUE_DEPTH} arrays and objects`;

describe("depth", () => {
  test("a value inside MAX_VALUE_DEPTH arrays and objects round-trips, and one level more is refused on encode and decode, naming its path", () => {
    expect(MAX_VALUE_DEPTH).toBe(256);
    for (const container of ["array", "object"] as const) {
      expectRoundTrip(nest(MAX_VALUE_DEPTH, "deep-leaf", container), `${container}, at the bound`);
      const deeper = nest(MAX_VALUE_DEPTH + 1, "deep-leaf", container);
      const path = nestedPath(MAX_VALUE_DEPTH, container);
      for (const [verb, run] of [
        ["encode", () => encodeValue(deeper)],
        ["decode", () => decodeValue(deeper)],
      ] as const) {
        const error = refusal(run);
        expect(error.path, `${container}, ${verb}`).toBe(path);
        expect(error.path.split("/").length - 1, `${container}, ${verb}`).toBe(MAX_VALUE_DEPTH);
        expect(error.message, `${container}, ${verb}`).toBe(
          `The value codec cannot ${verb} ${DEPTH_KIND}, at "${path}".`,
        );
        expect(error.message, `${container}, ${verb}`).not.toContain("deep-leaf");
      }
    }
  });

  test("a tagged value adds no level, so the bound counts the value's own arrays and objects", () => {
    const leaves: [string, unknown][] = [
      ["ts", new Date(0)],
      ["bytes", new Uint8Array([1, 2, 3])],
      ["i64", BigInt(9)],
      ["nf", Number.NaN],
    ];
    for (const [tag, leaf] of leaves) {
      const value = nest(MAX_VALUE_DEPTH, leaf, "object");
      expectRoundTrip(value, `a ${tag} leaf at the bound`);
    }
    // The obj escape is a data object: inside MAX_VALUE_DEPTH - 1 others it is the last level the bound allows.
    expectRoundTrip(nest(MAX_VALUE_DEPTH - 1, { $: "i64", v: "9" }, "array"), "an obj escape at the bound");
    const escaped = nest(MAX_VALUE_DEPTH, { $: "i64", v: "9" }, "array");
    const path = nestedPath(MAX_VALUE_DEPTH, "array");
    expect(refusal(() => encodeValue(escaped)).path).toBe(path);
    // On decode the wire's tag wrapper adds no level, so the payload is the container the bound refuses.
    const wire = nest(MAX_VALUE_DEPTH, { $: "obj", v: { $: "i64", v: "9" } }, "array");
    const decoded = refusal(() => decodeValue(wire));
    expect(decoded.path).toBe(path);
    expect(decoded.message).toBe(`The value codec cannot decode ${DEPTH_KIND}, at "${path}".`);
  });

  test("a cyclic object is refused by the depth rule, never a RangeError", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const run of [() => encodeValue(cyclic), () => decodeValue(cyclic)]) {
      const error = refusal(run);
      expect(error.path).toBe("/self".repeat(MAX_VALUE_DEPTH));
      expect(error.message).toContain(DEPTH_KIND);
    }
  });
});

describe("undefined", () => {
  test("an object member whose value is undefined is left out, and undefined anywhere else is refused", () => {
    expect(encodeValue({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(Object.keys(encodeValue({ a: 1, b: undefined }) as object)).toEqual(["a"]);
    expect(encodeValue([{ a: { b: undefined, c: [{ d: undefined }] } }])).toEqual([{ a: { c: [{}] } }]);
    expect(encodeValue({ only: undefined })).toEqual({});
    expect(refusal(() => encodeValue([undefined])).path).toBe("/0");
    expect(refusal(() => encodeValue([1, undefined])).path).toBe("/1");
    expect(refusal(() => encodeValue({ a: [undefined] })).path).toBe("/a/0");
    const atRoot = refusal(() => encodeValue(undefined));
    expect(atRoot.path).toBe("");
    expect(atRoot.message).toBe("The value codec cannot encode undefined, at the root.");
  });

  test("the obj escape is decided on the members written", () => {
    expect(encodeValue({ $: "i64", v: undefined })).toEqual({ $: "i64" });
    expect(decodeValue(encodeValue({ $: "i64", v: undefined }))).toEqual({ $: "i64" });
    expect(encodeValue({ $: 1, v: 2, w: undefined })).toEqual({ $: "obj", v: { $: 1, v: 2 } });
    expect(decodeValue(encodeValue({ $: 1, v: 2, w: undefined }))).toEqual({ $: 1, v: 2 });
    expect(encodeValue({ $: undefined, v: undefined })).toEqual({});
  });
});
