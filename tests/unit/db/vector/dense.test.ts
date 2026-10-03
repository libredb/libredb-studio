/**
 * Dense and multivector element checks (vector-family spec 3.3): the range table at its boundaries, integers read
 * exactly, and every dense and multivector cell of both engines' fixtures checked against its field.
 */
import { describe, expect, test } from "bun:test";
import { taggedNumber, type TaggedJson } from "@/lib/db/console/tagged-json";
import {
  checkDenseElements,
  checkMultiVector,
  DTYPE_RANGES,
  type VectorRefusal,
  type VectorTarget,
  vectorNumbers,
} from "@/lib/db/vector/dense";
import { VECTOR_DTYPES, type VectorDType } from "@/lib/db/vector/types";
import { ENGINES, expectedCells, MULTIVECTOR_ELEMENTS, tagged, targetOf } from "../../../helpers/vector-fixtures";

const target = (dtype: VectorDType, dimension: number | null = null, name = "v"): VectorTarget => ({
  name,
  kind: "dense",
  dtype,
  dimension,
});

/** The float32 just above a bound, from its bits. */
const float32FromBits = (bits: number): number => new Float32Array(new Uint32Array([bits]).buffer)[0];

describe("DTYPE_RANGES", () => {
  test("is exhaustive over VectorDType and frozen", () => {
    expect(Object.keys(DTYPE_RANGES).sort()).toEqual([...VECTOR_DTYPES].sort());
    expect(Object.isFrozen(DTYPE_RANGES)).toBe(true);
  });

  test("bfloat16's bound is the bfloat16 0x7f7f0000", () => {
    expect(DTYPE_RANGES.bfloat16).toEqual({ kind: "float", maxAbs: float32FromBits(0x7f7f0000) });
  });
});

describe("the range table at its boundaries", () => {
  test.each([
    ["float32", [3.4028234663852886e38, -3.4028234663852886e38, 1e-46, 0], [1e39, 3.4028235677973366e38, Number.NaN]],
    ["float64", [Number.MAX_VALUE, 1e39, -1e300], [Number.POSITIVE_INFINITY, Number.NaN]],
    ["float16", [65504, -65504, 5.960464477539063e-8, 1e-10], [65504.00390625, 65519.99, 65520, -65520]],
    [
      "bfloat16",
      [3.3895313892515355e38, -3.3895313892515355e38],
      [3.39617752923046e38, 3.4e38, 3.4028234663852886e38, float32FromBits(0x7f7f0001)],
    ],
    ["int8", [-128, 127, 0], [-129, 128, 1.5]],
    ["uint8", [0, 255], [-1, 256, 1.5]],
  ] as const)("%s accepts %p and refuses %p", (dtype, accepted, refused) => {
    for (const value of accepted) expect(checkDenseElements(target(dtype, 1), [value]), `${value}`).toBeNull();
    for (const value of refused) {
      const refusal = checkDenseElements(target(dtype, 1), [value]);
      expect(refusal?.index, `${value}`).toBe(0);
    }
  });

  test("binary takes integers from 0 to 255, exactly dimension / 8 bytes", () => {
    expect(checkDenseElements(target("binary", 16), [0, 255])).toBeNull();
    expect(checkDenseElements(target("binary", 16), [0, 256])?.index).toBe(1);
    expect(checkDenseElements(target("binary", 16), [0, 255, 1])).toEqual({
      field: "v",
      dtype: "binary",
      index: null,
      sentence: 'Vector field "v" (binary): 3 bytes given, a 16-bit binary vector takes exactly 2.',
    });
  });

  test("a refusal names the field, the element type, the position and the bound", () => {
    expect(checkDenseElements(target("float16", 2, "f16"), [1, 70000])).toEqual({
      field: "f16",
      dtype: "float16",
      index: 1,
      sentence:
        'Vector field "f16" (float16): element 1 is 70000, not a finite number of absolute value at most 65504.',
    });
    expect(checkDenseElements(target("int8", 1, ""), [1.5])?.sentence).toBe(
      "The unnamed vector (int8): element 0 is 1.5, not an integer from -128 to 127.",
    );
    expect(checkDenseElements(target("float64", 1), [Number.NaN])?.sentence).toBe(
      'Vector field "v" (float64): element 0 is NaN, not a finite number.',
    );
    expect(checkDenseElements(target("float32", 3), [1, 2])?.sentence).toBe(
      'Vector field "v" (float32): 2 elements given, the field\'s dimension is 3.',
    );
  });

  test("a field with no declared dimension checks the elements only", () => {
    expect(checkDenseElements(target("float32", null), [1, 2, 3])).toBeNull();
  });
});

describe("vectorNumbers", () => {
  test("reads float literals, safe integer literals and numbers Studio produced", () => {
    expect(
      vectorNumbers(target("float32"), [taggedNumber("0.5"), taggedNumber("-3"), 2, taggedNumber("9007199254740991")]),
    ).toEqual([0.5, -3, 2, 9007199254740991]);
  });

  test("refuses an integer literal outside the safe range, naming its position", () => {
    expect(vectorNumbers(target("float32", 2, "q"), [taggedNumber("1"), taggedNumber("9007199254740993")])).toEqual({
      field: "q",
      dtype: "float32",
      index: 1,
      sentence: 'Vector field "q" (float32): element 1 is 9007199254740993, outside the range a double holds exactly.',
    });
  });

  test.each([
    [null, "null"],
    ["0.5", "a string"],
    [true, "a boolean"],
    [[], "a list"],
    [tagged({ kind: "int", digits: "42" }), "an object"],
  ] as const)("refuses %j as %s", (value, kind) => {
    expect((vectorNumbers(target("int8", 1, "limit"), [value as TaggedJson]) as VectorRefusal).sentence).toBe(
      `Vector field "limit" (int8): element 0 is ${kind}, not a number.`,
    );
  });
});

describe("checkMultiVector", () => {
  const multi: VectorTarget = { name: "m", kind: "multi", dtype: "float32", dimension: 2 };

  test("accepts rows of the field's dimension within the element bound", () => {
    expect(
      checkMultiVector(
        multi,
        [
          [1, 2],
          [3, 4],
        ],
        4,
      ),
    ).toBeNull();
  });

  test("refuses no rows, rows past the bound, a row of the wrong length and an element out of range", () => {
    expect(checkMultiVector(multi, [], 4)?.sentence).toBe(
      'Vector field "m" (float32): a multivector holds at least one row.',
    );
    expect(
      checkMultiVector(
        multi,
        [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
        4,
      )?.sentence,
    ).toBe('Vector field "m" (float32): 3 rows hold 6 elements, above the bound of 4.');
    expect(checkMultiVector(multi, [[1, 2], [3]], 4)?.sentence).toBe(
      'Vector field "m" (float32): row 1 holds 1 elements, the field\'s dimension is 2.',
    );
    expect(
      checkMultiVector(
        multi,
        [
          [1, 2],
          [3, 1e39],
        ],
        4,
      ),
    ).toEqual({
      field: "m",
      dtype: "float32",
      index: 3,
      sentence:
        'Vector field "m" (float32): row 1, element 1 is 1e+39, not a finite number of absolute value at most 3.4028234663852886e+38.',
    });
    expect(checkMultiVector({ ...multi, dimension: null }, [[1], [2, 3]], 4)).toBeNull();
  });
});

for (const engine of ENGINES) {
  describe(`${engine}'s dense and multivector cells`, () => {
    const cells = expectedCells(engine).cells.filter((cell) => cell.kind !== "sparse");

    test("each passes its field's check, and an element the engine could not store is refused by position", () => {
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        const field = targetOf(engine, cell.collection, cell.field);
        const where = `${cell.collection} seq ${cell.seq} ${cell.field}`;
        if (cell.kind === "multi") {
          const rows = (cell.cell as unknown[][]).map((row) => vectorNumbers(field, row.map(tagged)) as number[]);
          expect(checkMultiVector(field, rows, MULTIVECTOR_ELEMENTS[engine]), where).toBeNull();
          continue;
        }
        const elements = cell.cell as (number | null)[];
        const numbers = vectorNumbers(field, elements.map(tagged));
        if (elements.includes(null)) {
          expect((numbers as VectorRefusal).index, where).toBe(elements.indexOf(null));
        } else {
          expect(checkDenseElements(field, numbers as number[]), where).toBeNull();
        }
      }
    });
  });
}

describe("a binary field whose dimension is not whole bytes", () => {
  test("is refused as a shape, with no fractional byte count", () => {
    const target = { name: "b", kind: "dense", dtype: "binary", dimension: 12 } as const;
    for (const values of [[1], [1, 2]]) {
      expect(checkDenseElements(target, values)).toEqual({
        field: "b",
        dtype: "binary",
        index: null,
        sentence:
          'Vector field "b" (binary): the field\'s dimension is 12 bits, which is not a whole number of bytes, so no byte vector fits it.',
      });
    }
  });
});
