import { describe, expect, test } from "bun:test";
import { nonFiniteWord, rowsWithNonFiniteWords, withNonFiniteWords } from "@/lib/non-finite";

describe("nonFiniteWord", () => {
  test("names the three numbers JSON has no form for", () => {
    expect(nonFiniteWord(Number.NaN)).toBe("NaN");
    expect(nonFiniteWord(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(nonFiniteWord(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
  });

  test("answers nothing for a finite number, zero and the extremes included", () => {
    for (const finite of [0, -0, 1.5, -2, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE]) {
      expect(nonFiniteWord(finite)).toBeUndefined();
    }
  });
});

describe("withNonFiniteWords", () => {
  test("replaces a top-level non-finite number and leaves every other scalar alone", () => {
    expect(withNonFiniteWords(Number.NaN)).toBe("NaN");
    expect(withNonFiniteWords(1.5)).toBe(1.5);
    expect(withNonFiniteWords(null)).toBeNull();
    expect(withNonFiniteWords(undefined)).toBeUndefined();
    expect(withNonFiniteWords("NaN")).toBe("NaN");
    expect(withNonFiniteWords(true)).toBe(true);
  });

  test("reaches into arrays and plain objects at any depth", () => {
    const value = { f: [Number.NaN, 2, [Number.NEGATIVE_INFINITY]], doc: { inner: { r: Number.POSITIVE_INFINITY } } };

    expect(withNonFiniteWords(value)).toEqual({
      f: ["NaN", 2, ["-Infinity"]],
      doc: { inner: { r: "Infinity" } },
    });
    // The input is not written to: a cached result or a host's own rows stay as they were.
    expect(Number.isNaN(value.f[0])).toBe(true);
  });

  test("hands back the same reference when there is nothing to replace", () => {
    const rows = [{ a: 1, b: "x", c: null, d: [1, 2], e: { f: 3 } }];

    expect(withNonFiniteWords(rows)).toBe(rows);
  });

  test("copies only the containers on the path to a replaced number", () => {
    const untouched = { g: 1 };
    const row = { a: Number.NaN, b: untouched };

    const out = withNonFiniteWords([row]) as Array<Record<string, unknown>>;

    expect(out[0]).not.toBe(row);
    expect(out[0].b).toBe(untouched);
  });

  // A Date, a Buffer or a driver's class instance serialises through its own `toJSON`, and
  // rebuilding one as a plain object would lose that, so only plain containers are walked.
  test("leaves a Date, a typed array and a class instance as they are", () => {
    class Point {
      x = Number.NaN;
    }
    const date = new Date("2026-10-04T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2]);
    const point = new Point();

    const out = withNonFiniteWords({ date, bytes, point }) as Record<string, unknown>;

    expect(out.date).toBe(date);
    expect(out.bytes).toBe(bytes);
    expect(out.point).toBe(point);
  });

  test("walks an object with no prototype", () => {
    const row = Object.create(null) as Record<string, unknown>;
    row.v = Number.NaN;

    expect(withNonFiniteWords(row)).toEqual({ v: "NaN" });
  });

  // A column may be named `__proto__`; a plain assignment would set the copy's prototype
  // and drop the cell.
  test("keeps a column named __proto__ as a column", () => {
    const row = JSON.parse('{"__proto__": 1, "v": 2}') as Record<string, unknown>;
    row.v = Number.NaN;

    const out = withNonFiniteWords(row) as Record<string, unknown>;

    expect(Object.keys(out)).toEqual(["__proto__", "v"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":1,"v":"NaN"}');
  });
});

describe("rowsWithNonFiniteWords", () => {
  test("is what JSON.stringify then carries instead of null", () => {
    const rows = [{ f: Number.NaN, r: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY, ok: 1.5, z: null }];

    expect(JSON.stringify(rows)).toBe('[{"f":null,"r":null,"n":null,"ok":1.5,"z":null}]');
    expect(JSON.stringify(rowsWithNonFiniteWords(rows))).toBe(
      '[{"f":"NaN","r":"Infinity","n":"-Infinity","ok":1.5,"z":null}]',
    );
  });
});
