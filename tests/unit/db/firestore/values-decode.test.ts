/**
 * REST values to grid cells and Firestore type names (spec 5.6). The decoder reads the one key a value carries and
 * never guesses from the JSON form of a number.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import {
  decodeFields,
  decodeValue,
  isVectorValue,
  type RestValue,
  typeNameOf,
  VALUE_SENTENCES as V,
  vectorOf,
} from "@/lib/db/providers/document/firestore/values";

const T: FirestoreTarget = { projectId: "demo-libredb", databaseId: "(default)" };
const ROOT = "projects/demo-libredb/databases/(default)/documents";

function vector(values: readonly RestValue[]): RestValue {
  return {
    mapValue: { fields: { __type__: { stringValue: "__vector__" }, value: { arrayValue: { values } } } },
  };
}

function bson(key: string, inner: RestValue): RestValue {
  return { mapValue: { fields: { [key]: inner } } };
}

function refusal(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QueryError);
  expect((caught as QueryError).provider).toBe(FIRESTORE_TYPE);
  return (caught as Error).message;
}

describe("decodeValue: the cell table", () => {
  test("null in both encodings, booleans, strings and timestamps as sent", () => {
    expect(decodeValue({ nullValue: null }, T)).toBeNull();
    expect(decodeValue({ nullValue: "NULL_VALUE" }, T)).toBeNull();
    expect(decodeValue({ booleanValue: false }, T)).toBe(false);
    expect(decodeValue({ stringValue: "a" }, T)).toBe("a");
    expect(decodeValue({ timestampValue: "2026-10-12T01:02:03.123456789Z" }, T)).toBe("2026-10-12T01:02:03.123456789Z");
  });

  test("integers: a number within 2^53 - 1, the exact digits beyond it", () => {
    expect(decodeValue({ integerValue: "42" }, T)).toBe(42);
    expect(decodeValue({ integerValue: "-9007199254740991" }, T)).toBe(-9007199254740991);
    expect(decodeValue({ integerValue: "9007199254740991" }, T)).toBe(9007199254740991);
    expect(decodeValue({ integerValue: "9007199254740992" }, T)).toBe("9007199254740992");
    expect(decodeValue({ integerValue: "-9223372036854775808" }, T)).toBe("-9223372036854775808");
    expect(decodeValue({ integerValue: 7 }, T)).toBe(7);
  });

  test("doubles: numbers, numeric text, and the specials as their strings", () => {
    expect(decodeValue({ doubleValue: 1.5 }, T)).toBe(1.5);
    expect(decodeValue({ doubleValue: 3 }, T)).toBe(3);
    expect(decodeValue({ doubleValue: "2.5e3" }, T)).toBe(2500);
    expect(decodeValue({ doubleValue: "NaN" }, T)).toBe("NaN");
    expect(decodeValue({ doubleValue: "Infinity" }, T)).toBe("Infinity");
    expect(decodeValue({ doubleValue: "-Infinity" }, T)).toBe("-Infinity");
  });

  test("bytes, references in and out of this database, geopoints with an absent coordinate", () => {
    expect(decodeValue({ bytesValue: "AAE=" }, T)).toEqual({ bytesValue: "AAE=" });
    expect(decodeValue({ referenceValue: `${ROOT}/users/alice` }, T)).toEqual({ referenceValue: "users/alice" });
    const foreign = "projects/other-project/databases/(default)/documents/users/alice";
    expect(decodeValue({ referenceValue: foreign }, T)).toEqual({ referenceValue: foreign });
    expect(decodeValue({ referenceValue: ROOT }, T)).toEqual({ referenceValue: ROOT });
    expect(decodeValue({ geoPointValue: { latitude: 41.01, longitude: 28.97 } }, T)).toEqual({
      geoPointValue: { latitude: 41.01, longitude: 28.97 },
    });
    expect(decodeValue({ geoPointValue: { latitude: 41 } }, T)).toEqual({
      geoPointValue: { latitude: 41, longitude: 0 },
    });
    expect(decodeValue({ geoPointValue: {} }, T)).toEqual({ geoPointValue: { latitude: 0, longitude: 0 } });
  });

  test("arrays and maps recurse, and a missing values or fields key is empty", () => {
    expect(decodeValue({ arrayValue: {} }, T)).toEqual([]);
    expect(decodeValue({ arrayValue: { values: [{ stringValue: "a" }, { integerValue: "1" }] } }, T)).toEqual(["a", 1]);
    expect(decodeValue({ mapValue: {} }, T)).toEqual({});
    expect(
      decodeValue({ mapValue: { fields: { a: { mapValue: { fields: { b: { arrayValue: {} } } } } } } }, T),
    ).toEqual({ a: { b: [] } });
  });

  test("a vector becomes its tagged cell; a reserved BSON map is decoded as a map", () => {
    expect(decodeValue(vector([{ doubleValue: 1 }, { doubleValue: 2.5 }]), T)).toEqual({
      __type__: "__vector__",
      value: [1, 2.5],
    });
    expect(decodeValue({ mapValue: { fields: { __type__: { stringValue: "__vector__" } } } }, T)).toEqual({
      __type__: "__vector__",
      value: [],
    });
    expect(decodeValue(bson("__oid__", { stringValue: "507f1f77bcf86cd799439011" }), T)).toEqual({
      __oid__: "507f1f77bcf86cd799439011",
    });
  });

  test("a field named __proto__ is an own field and leaves the prototype alone", () => {
    const fields = JSON.parse('{"__proto__": {"stringValue": "x"}, "a": {"booleanValue": true}}');
    const decoded = decodeFields(fields, T);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe("x");
    expect(decoded.a).toBe(true);
    expect(decodeFields(undefined, T)).toEqual({});
  });

  test("a malformed value is an explicit error", () => {
    expect(refusal(() => decodeValue({}, T))).toBe(V.unreadable("0 keys in one value"));
    expect(refusal(() => decodeValue({ stringValue: "a", integerValue: "1" }, T))).toBe(
      V.unreadable("2 keys in one value"),
    );
    expect(refusal(() => decodeValue({ fooValue: 1 }, T))).toBe(V.unreadable("the key fooValue"));
    expect(refusal(() => decodeValue(null as unknown as RestValue, T))).toBe(
      V.unreadable("a value that is not an object"),
    );
    expect(refusal(() => decodeValue({ nullValue: 0 }, T))).toBe(V.unreadable("nullValue"));
    expect(refusal(() => decodeValue({ booleanValue: "true" }, T))).toBe(V.unreadable("booleanValue"));
    expect(refusal(() => decodeValue({ integerValue: "1.5" }, T))).toBe(V.unreadable("integerValue"));
    expect(refusal(() => decodeValue({ integerValue: 2 ** 60 }, T))).toBe(V.unreadable("integerValue"));
    expect(refusal(() => decodeValue({ doubleValue: "abc" }, T))).toBe(V.unreadable("doubleValue"));
    expect(refusal(() => decodeValue({ stringValue: 1 }, T))).toBe(V.unreadable("stringValue"));
    expect(refusal(() => decodeValue({ bytesValue: 1 }, T))).toBe(V.unreadable("bytesValue"));
    expect(refusal(() => decodeValue({ referenceValue: 1 }, T))).toBe(V.unreadable("referenceValue"));
    expect(refusal(() => decodeValue({ geoPointValue: { latitude: "1" } }, T))).toBe(V.unreadable("geoPointValue"));
    expect(refusal(() => decodeValue({ geoPointValue: "x" }, T))).toBe(V.unreadable("geoPointValue"));
    expect(refusal(() => decodeValue({ arrayValue: { values: {} } }, T))).toBe(V.unreadable("arrayValue"));
    expect(refusal(() => decodeValue({ mapValue: { fields: [] } }, T))).toBe(V.unreadable("mapValue"));
    expect(
      refusal(() =>
        decodeValue(
          { mapValue: { fields: { __type__: { stringValue: "__vector__" }, value: { stringValue: "x" } } } },
          T,
        ),
      ),
    ).toBe(V.unreadable("a vector whose value is not an array"));
  });
});

describe("typeNameOf", () => {
  test("each REST key", () => {
    expect(typeNameOf({ nullValue: null })).toBe("null");
    expect(typeNameOf({ booleanValue: true })).toBe("boolean");
    expect(typeNameOf({ integerValue: "1" })).toBe("integer");
    expect(typeNameOf({ doubleValue: 1 })).toBe("double");
    expect(typeNameOf({ timestampValue: "2026-01-01T00:00:00Z" })).toBe("timestamp");
    expect(typeNameOf({ stringValue: "a" })).toBe("string");
    expect(typeNameOf({ bytesValue: "" })).toBe("bytes");
    expect(typeNameOf({ referenceValue: `${ROOT}/a/b` })).toBe("reference");
    expect(typeNameOf({ geoPointValue: {} })).toBe("geopoint");
    expect(typeNameOf({ arrayValue: {} })).toBe("array");
    expect(typeNameOf({ mapValue: {} })).toBe("map");
  });

  test("vectors and the reserved BSON maps, detected as the SDK detects them", () => {
    expect(typeNameOf(vector([]))).toBe("vector");
    expect(
      typeNameOf({
        mapValue: {
          fields: { __type__: { stringValue: "__vector__" }, value: { arrayValue: {} }, x: { nullValue: null } },
        },
      }),
    ).toBe("vector");
    expect(typeNameOf({ mapValue: { fields: { __type__: { stringValue: "other" } } } })).toBe("map");
    expect(typeNameOf(bson("__min__", { nullValue: null }))).toBe("minKey");
    expect(typeNameOf(bson("__max__", { nullValue: null }))).toBe("maxKey");
    expect(typeNameOf(bson("__regex__", { mapValue: {} }))).toBe("regex");
    expect(typeNameOf(bson("__oid__", { stringValue: "x" }))).toBe("objectId");
    expect(typeNameOf(bson("__int__", { integerValue: "1" }))).toBe("int32");
    expect(typeNameOf(bson("__int__", { stringValue: "1" }))).toBe("map");
    expect(typeNameOf(bson("__decimal128__", { stringValue: "1.5" }))).toBe("decimal128");
    expect(typeNameOf(bson("__request_timestamp__", { mapValue: {} }))).toBe("bsonTimestamp");
    expect(typeNameOf(bson("__binary__", { bytesValue: "AA==" }))).toBe("bsonBinary");
    expect(typeNameOf({ mapValue: { fields: { __oid__: { stringValue: "x" }, y: { nullValue: null } } } })).toBe("map");
    expect(typeNameOf(bson("constructor", { nullValue: null }))).toBe("map");
  });
});

describe("isVectorValue and vectorOf", () => {
  test("a vector's numbers, integers included", () => {
    expect(isVectorValue(vector([{ doubleValue: 1 }]))).toBe(true);
    expect(vectorOf(vector([{ doubleValue: 1 }, { doubleValue: "2.5" }, { integerValue: "3" }]))).toEqual([1, 2.5, 3]);
    expect(vectorOf({ mapValue: { fields: { __type__: { stringValue: "__vector__" } } } })).toEqual([]);
  });

  test("null for a non-vector, a non-array holder and a non-finite or non-number element", () => {
    expect(isVectorValue({ arrayValue: {} })).toBe(false);
    expect(vectorOf({ arrayValue: {} })).toBeNull();
    expect(vectorOf(vector([{ doubleValue: "NaN" }]))).toBeNull();
    expect(vectorOf(vector([{ stringValue: "1" }]))).toBeNull();
    expect(
      vectorOf({ mapValue: { fields: { __type__: { stringValue: "__vector__" }, value: { stringValue: "x" } } } }),
    ).toBeNull();
  });

  test("a malformed element is refused, not read as null", () => {
    expect(refusal(() => vectorOf(vector([{ doubleValue: "abc" }])))).toBe(V.unreadable("doubleValue"));
  });
});
