/**
 * Console literals to REST values (spec 5.4): integers keep their decimal text, doubles stay doubles, timestamps
 * and geopoints are range-checked, references become full names and vector elements are always doubles.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import { type FirestoreTarget, NAME_SENTENCES as N } from "@/lib/db/providers/document/firestore/names";
import { encodeLiteral, type Literal, VALUE_SENTENCES as V } from "@/lib/db/providers/document/firestore/values";

const T: FirestoreTarget = { projectId: "demo-libredb", databaseId: "(default)" };
const ROOT = "projects/demo-libredb/databases/(default)/documents";

function refusal(literal: Literal): string {
  let caught: unknown;
  try {
    encodeLiteral(literal, T);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QueryError);
  expect((caught as QueryError).provider).toBe(FIRESTORE_TYPE);
  return (caught as Error).message;
}

describe("encodeLiteral", () => {
  test("null, booleans and strings", () => {
    expect(encodeLiteral({ kind: "null" }, T)).toEqual({ nullValue: null });
    expect(encodeLiteral({ kind: "boolean", value: true }, T)).toEqual({ booleanValue: true });
    expect(encodeLiteral({ kind: "string", value: "\u00e7a\u011fr\u0131" }, T)).toEqual({
      stringValue: "\u00e7a\u011fr\u0131",
    });
    expect(refusal({ kind: "string", value: "a\uD800" })).toBe(V.stringMalformed);
  });

  test("integers: canonical decimal text across the whole 64-bit range, refused beyond it", () => {
    expect(encodeLiteral({ kind: "integer", text: "42" }, T)).toEqual({ integerValue: "42" });
    expect(encodeLiteral({ kind: "integer", text: "007" }, T)).toEqual({ integerValue: "7" });
    expect(encodeLiteral({ kind: "integer", text: "-0" }, T)).toEqual({ integerValue: "0" });
    expect(encodeLiteral({ kind: "integer", text: "9223372036854775807" }, T)).toEqual({
      integerValue: "9223372036854775807",
    });
    expect(encodeLiteral({ kind: "integer", text: "-9223372036854775808" }, T)).toEqual({
      integerValue: "-9223372036854775808",
    });
    expect(refusal({ kind: "integer", text: "9223372036854775808" })).toBe(V.integerRange);
    expect(refusal({ kind: "integer", text: "-9223372036854775809" })).toBe(V.integerRange);
    expect(refusal({ kind: "integer", text: "1.0" })).toBe(V.integerText);
    expect(refusal({ kind: "integer", text: "" })).toBe(V.integerText);
  });

  test("doubles: finite numbers and the three special strings", () => {
    expect(encodeLiteral({ kind: "double", value: 1 }, T)).toEqual({ doubleValue: 1 });
    expect(encodeLiteral({ kind: "double", value: 1.5 }, T)).toEqual({ doubleValue: 1.5 });
    expect(encodeLiteral({ kind: "double", value: "NaN" }, T)).toEqual({ doubleValue: "NaN" });
    expect(encodeLiteral({ kind: "double", value: "-Infinity" }, T)).toEqual({ doubleValue: "-Infinity" });
    expect(refusal({ kind: "double", value: Number.POSITIVE_INFINITY })).toBe(V.doubleRange);
    expect(refusal({ kind: "double", value: Number.NaN })).toBe(V.doubleRange);
  });

  test("timestamps: RFC 3339 in UTC, nanoseconds kept, the whole 0001 to 9999 range", () => {
    expect(encodeLiteral({ kind: "timestamp", seconds: "0", nanos: 0 }, T)).toEqual({
      timestampValue: "1970-01-01T00:00:00Z",
    });
    expect(encodeLiteral({ kind: "timestamp", seconds: "1", nanos: 5 }, T)).toEqual({
      timestampValue: "1970-01-01T00:00:01.000000005Z",
    });
    expect(encodeLiteral({ kind: "timestamp", seconds: "-62135596800", nanos: 0 }, T)).toEqual({
      timestampValue: "0001-01-01T00:00:00Z",
    });
    expect(encodeLiteral({ kind: "timestamp", seconds: "253402300799", nanos: 999_999_999 }, T)).toEqual({
      timestampValue: "9999-12-31T23:59:59.999999999Z",
    });
    expect(refusal({ kind: "timestamp", seconds: "-62135596801", nanos: 0 })).toBe(V.timestampRange);
    expect(refusal({ kind: "timestamp", seconds: "253402300800", nanos: 0 })).toBe(V.timestampRange);
    expect(refusal({ kind: "timestamp", seconds: "1.5", nanos: 0 })).toBe(V.timestampRange);
    expect(refusal({ kind: "timestamp", seconds: "0", nanos: 1_000_000_000 })).toBe(V.timestampNanos);
    expect(refusal({ kind: "timestamp", seconds: "0", nanos: -1 })).toBe(V.timestampNanos);
    expect(refusal({ kind: "timestamp", seconds: "0", nanos: 1.5 })).toBe(V.timestampNanos);
  });

  test("geopoints: inclusive ranges", () => {
    expect(encodeLiteral({ kind: "geopoint", latitude: 90, longitude: 180 }, T)).toEqual({
      geoPointValue: { latitude: 90, longitude: 180 },
    });
    expect(encodeLiteral({ kind: "geopoint", latitude: -90, longitude: -180 }, T)).toEqual({
      geoPointValue: { latitude: -90, longitude: -180 },
    });
    expect(refusal({ kind: "geopoint", latitude: 90.0001, longitude: 0 })).toBe(V.latitude);
    expect(refusal({ kind: "geopoint", latitude: Number.NaN, longitude: 0 })).toBe(V.latitude);
    expect(refusal({ kind: "geopoint", latitude: 0, longitude: 180.5 })).toBe(V.longitude);
  });

  test("references: the full name of a valid even-segment path", () => {
    expect(encodeLiteral({ kind: "reference", segments: ["users", "a:b"] }, T)).toEqual({
      referenceValue: `${ROOT}/users/a:b`,
    });
    expect(refusal({ kind: "reference", segments: ["users"] })).toBe(V.referencePath);
    expect(refusal({ kind: "reference", segments: [] })).toBe(V.referencePath);
    expect(refusal({ kind: "reference", segments: ["users", "__x__"] })).toBe(
      N.pathSegment(2, "document", N.idReserved("document")),
    );
  });

  test("vectors: the reserved map, every element a doubleValue, at most 2,048", () => {
    expect(encodeLiteral({ kind: "vector", values: [1, 2.5] }, T)).toEqual({
      mapValue: {
        fields: {
          __type__: { stringValue: "__vector__" },
          value: { arrayValue: { values: [{ doubleValue: 1 }, { doubleValue: 2.5 }] } },
        },
      },
    });
    expect(encodeLiteral({ kind: "vector", values: new Array(2_048).fill(0) }, T)).toBeDefined();
    expect(refusal({ kind: "vector", values: new Array(2_049).fill(0) })).toBe(V.vectorDimensions);
    expect(refusal({ kind: "vector", values: [1, Number.NaN] })).toBe(V.vectorElement);
  });

  test("arrays and maps recurse; a map key named __proto__ stays a field", () => {
    expect(
      encodeLiteral(
        {
          kind: "array",
          items: [
            { kind: "integer", text: "1" },
            { kind: "string", value: "a" },
          ],
        },
        T,
      ),
    ).toEqual({ arrayValue: { values: [{ integerValue: "1" }, { stringValue: "a" }] } });
    const encoded = encodeLiteral(
      {
        kind: "map",
        entries: [
          ["__proto__", { kind: "boolean", value: true }],
          ["b", { kind: "null" }],
        ],
      },
      T,
    );
    const fields = (encoded.mapValue as { fields: Record<string, unknown> }).fields;
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(fields, "__proto__")?.value).toEqual({ booleanValue: true });
    expect(fields.b).toEqual({ nullValue: null });
    expect(refusal({ kind: "map", entries: [["a\uD800", { kind: "null" }]] })).toBe(V.stringMalformed);
  });
});
