/**
 * RFC 8785 canonical JSON for what `lsb1` envelopes bind (docs/GOVERNANCE.md#sealed-credentials-lsb1).
 *
 * A control plane and Studio each hash the canonical form of a connection definition into the additional
 * authenticated data of every envelope, so the two implementations must agree byte for byte. The samples below are
 * the RFC's own: section 3.2.2 for strings, numbers and literals, section 3.2.3 for the key order, and appendix B for
 * number serialisation.
 */
import { describe, expect, test } from "bun:test";
import { assertDefinitionValues, CanonicalJsonError, canonicalJson } from "@/lib/governance/jcs";

/** What `run` threw, so a test can read its class, message and path together. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

/** The JSON path a CanonicalJsonError names, or the error itself when it is something else. */
const refusedAt = (run: () => unknown): unknown => {
  const error = thrownBy(run);
  return error instanceof CanonicalJsonError ? error.path : error;
};

describe("canonicalJson", () => {
  test("keys sort by UTF-16 code units, and NaN or 1.5 in a definition are refused", () => {
    // RFC 8785 section 3.2.3. U+1F600 is above U+FB33 as a code point, but its first UTF-16 code unit, 0xD83D, is
    // below 0xFB33, so the emoji sorts first: code-point order would put it last.
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
        '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    const [control, oDiaeresis, euro, grinningFace, daletDagesh] = [0x80, 0xf6, 0x20ac, 0x1f600, 0xfb33].map((point) =>
      String.fromCodePoint(point),
    );
    expect(canonicalJson(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","${control}":"Control","${oDiaeresis}":"Latin Small Letter O With Diaeresis",` +
        `"${euro}":"Euro Sign","${grinningFace}":"Emoji: Grinning Face","${daletDagesh}":"Hebrew Letter Dalet With Dagesh"}`,
    );

    expect(refusedAt(() => assertDefinitionValues({ host: "db", port: Number.NaN }))).toBe("$.port");
    expect(refusedAt(() => assertDefinitionValues({ host: "db", port: 1.5 }))).toBe("$.port");
    expect(refusedAt(() => canonicalJson({ port: Number.NaN }))).toBe("$.port");
  });

  test("strings, numbers and literals serialise as RFC 8785 section 3.2.2 shows", () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], ' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        `"string":"${String.fromCodePoint(0x20ac)}$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`,
    );
  });

  test("numbers serialise as ECMAScript does, with -0 as 0", () => {
    // RFC 8785 appendix B.
    const samples: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [5e-324, "5e-324"],
      [-1.7976931348623157e308, "-1.7976931348623157e+308"],
      [9007199254740992, "9007199254740992"],
      [295147905179352830000, "295147905179352830000"],
      [1e21, "1e+21"],
      [0.000001, "0.000001"],
      [1e-7, "1e-7"],
    ];
    for (const [value, expected] of samples) expect(canonicalJson(value)).toBe(expected);
  });

  test("nested objects sort at every depth, arrays keep their order, and nothing adds whitespace", () => {
    expect(canonicalJson([{ b: [2, { d: true, c: null }], a: "x" }, "y", []])).toBe(
      '[{"a":"x","b":[2,{"c":null,"d":true}]},"y",[]]',
    );
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  test("non-finite numbers and values JSON cannot carry are refused with the path they sit at", () => {
    expect(refusedAt(() => canonicalJson(Number.POSITIVE_INFINITY))).toBe("$");
    expect(refusedAt(() => canonicalJson({ a: [1, Number.NEGATIVE_INFINITY] }))).toBe("$.a[1]");
    expect(refusedAt(() => canonicalJson(undefined))).toBe("$");
    expect(refusedAt(() => canonicalJson({ a: undefined }))).toBe("$.a");
    // A hole in a sparse array is not a value; JSON.stringify would write null for it.
    expect(refusedAt(() => canonicalJson(Object.assign([], { 0: 1, 2: 3 })))).toBe("$[1]");
    expect(refusedAt(() => canonicalJson({ run: () => 1 }))).toBe("$.run");
    expect(refusedAt(() => canonicalJson({ id: Symbol("x") }))).toBe("$.id");
    expect(refusedAt(() => canonicalJson({ big: BigInt(1) }))).toBe("$.big");
    // An object that is not a plain object is refused rather than turned into what its toJSON returns.
    expect(refusedAt(() => canonicalJson({ at: new Date(0) }))).toBe("$.at");
    expect(refusedAt(() => canonicalJson(new Map()))).toBe("$");
  });
});

describe("assertDefinitionValues", () => {
  test("admits strings, booleans, null, integers below 2^53 in magnitude, and objects and arrays of these", () => {
    const definition = {
      host: "db.example.internal",
      port: 5432,
      skipObjectScan: false,
      schema: null,
      ssl: { mode: "verify-full", rejectUnauthorized: true, caCert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END..." },
      tags: ["a", 0, -0, [true, null], {}],
      largest: Number.MAX_SAFE_INTEGER,
      smallest: Number.MIN_SAFE_INTEGER,
    };
    expect(() => assertDefinitionValues(definition)).not.toThrow();
    expect(() => assertDefinitionValues({})).not.toThrow();
  });

  test("refuses a number that is not an integer below 2^53 in magnitude, naming its path and not its value", () => {
    expect(refusedAt(() => assertDefinitionValues({ big: 2 ** 53 }))).toBe("$.big");
    expect(refusedAt(() => assertDefinitionValues({ small: -(2 ** 53) }))).toBe("$.small");
    expect(refusedAt(() => assertDefinitionValues({ ssl: { timeout: Number.POSITIVE_INFINITY } }))).toBe(
      "$.ssl.timeout",
    );
    expect(refusedAt(() => assertDefinitionValues({ list: ["a", 0.25] }))).toBe("$.list[1]");

    const error = thrownBy(() => assertDefinitionValues({ ssl: { port: 1.5 } }));
    expect(error).toBeInstanceOf(CanonicalJsonError);
    expect((error as Error).message).toContain("$.ssl.port");
    expect((error as Error).message).not.toContain("1.5");
  });

  test("refuses a definition that is not a JSON object, and any value that is not a JSON value", () => {
    for (const definition of [[], "host", null, 5, new Date(0)]) {
      expect(refusedAt(() => assertDefinitionValues(definition))).toBe("$");
    }
    expect(refusedAt(() => assertDefinitionValues({ host: undefined }))).toBe("$.host");
    expect(refusedAt(() => assertDefinitionValues({ list: Object.assign([], { 0: 1, 2: 3 }) }))).toBe("$.list[1]");
    expect(refusedAt(() => assertDefinitionValues({ ssl: { at: new Date(0) } }))).toBe("$.ssl.at");
    expect(refusedAt(() => assertDefinitionValues({ big: BigInt(1) }))).toBe("$.big");
  });
});
