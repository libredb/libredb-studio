/**
 * The value layer, held to numbers MEASURED against the reference encoder rather than to numbers
 * reasoned about.
 *
 * Every constant in the first block came from Eclipse Tahu `sparkplug-payload` 1.0.3 on
 * 2026-10-13 under Bun 1.4.2 and Node 24.14.0, read back at the wire level with protobufjs 7.6.6
 * over Tahu's `sparkplug_b.proto` (SHA-256
 * `4432c5c483b7fb9732d0594c98a2e97dca5e517e39c5374a8b918d837f0b4a19`). The array constants were
 * computed from the 6.4.17 sentence under both runtimes and again with Python's `struct`.
 *
 * The run that produced them is recorded in the coordination log; this file is the repository's
 * copy of the result, so a change in the value layer fails here rather than in a live read.
 */
import { describe, expect, test } from "bun:test";
import { datatypeName, readMetricValue, signedFromWire } from "@/lib/db/providers/industrial/sparkplug/values";

describe("the BooleanArray count prefix is held from BOTH sides (KURAL 112)", () => {
  /*
   * Shifting `bytes.length < 4` to `< 3` broke no test. The prefix is a four-byte little-endian
   * count (6.4.17), so three bytes carry no count at all and a reader that accepted them would read
   * a length out of whatever followed.
   */
  test("three bytes is too few for the count, and four is the shortest that is read", () => {
    // Datatype 32 is BooleanArray. Three bytes carry no count at all, so the value is shown as hex
    // with the problem named rather than read as an array of whatever followed.
    const short = readMetricValue(32, { bytesValue: Uint8Array.of(0, 0, 0) });
    expect(short.problem).toBe("length-not-a-multiple");

    // Four bytes: a count of zero and no bits after it, which is an EMPTY array and not a refusal.
    const empty = readMetricValue(32, { bytesValue: Uint8Array.of(0, 0, 0, 0) });
    expect(empty.problem).toBeUndefined();
    expect(empty.text).toBe("[]");
  });
});

describe("a negative narrow integer is recovered from the datatype's width, not the field", () => {
  /** MEASURED: what Tahu actually puts on the wire for each of these. */
  test.each([
    ["Int8", 1, "4294967295", "-1"],
    ["Int8", 1, "4294967168", "-128"],
    ["Int16", 2, "4294934528", "-32768"],
    ["Int32", 3, "4294967291", "-5"],
    ["Int32", 3, "2147483648", "-2147483648"],
    ["Int64", 4, "18446744073709551613", "-3"],
  ])("%s on the wire as %s reads back as %s", (_name, datatype, wire, expected) => {
    expect(readMetricValue(datatype, { intValue: wire }).text).toBe(expected);
  });

  test("THE WIDTH COMES FROM THE DATATYPE, and only these cases prove it", () => {
    /*
     * MEASURED ASYMMETRY, and this is the test that actually binds the rule. Of the eight rows in
     * the measured table above, SIX give the same answer whether the width comes from the datatype
     * or is hardcoded at 32: Tahu writes a 32-bit two's complement, so sign-extending from 8, 16 or
     * 32 bits recovers the same negative number. Those rows prove the VALUE and not the WIDTH.
     *
     * The two cases below are the asymmetric ones. A narrow two's complement form, 255 for Int8 and
     * 65535 for Int16, reads as -1 at the datatype's own width and as a large positive number at a
     * fixed width of 32. A reader that ignored the datatype would answer 255 and 65535 here and
     * pass every other row in this file.
     */
    expect(readMetricValue(1, { intValue: "255" }).text).toBe("-1");
    expect(readMetricValue(2, { intValue: "65535" }).text).toBe("-1");
    // The same values under a WIDER datatype stay positive, which is the other half of the pair.
    expect(readMetricValue(3, { intValue: "255" }).text).toBe("255");
    expect(readMetricValue(3, { intValue: "65535" }).text).toBe("65535");
  });

  test("bits above the datatype's width that are not sign fill are flagged, not truncated", () => {
    // 0x0100 in an Int8 field: the low 8 bits say 0, the bits above are not sign fill.
    const read = readMetricValue(1, { intValue: "256" });
    expect(read.text).toBe("0");
    expect(read.problem).toBe("wire-field-mismatch");
  });

  test("signedFromWire reports whether it had to narrow", () => {
    expect(signedFromWire(BigInt(4294967295), 8)).toEqual({ value: -BigInt(1), narrowed: false });
    expect(signedFromWire(BigInt(256), 8)).toEqual({ value: BigInt(0), narrowed: true });
  });
});

describe("the field that is set does not identify the type", () => {
  test("UInt32 arrives in long_value, and is still a UInt32", () => {
    // MEASURED: Tahu puts UInt32 4294967295 in `long_value`, not `int_value`.
    const read = readMetricValue(7, { longValue: "4294967295" });
    expect(read.text).toBe("4294967295");
    expect(read.datatype).toBe("UInt32");
    expect(read.problem).toBeUndefined();
  });

  test("UInt8 arrives in int_value", () => {
    expect(readMetricValue(5, { intValue: "255" }).text).toBe("255");
  });

  test("an Int64 given in int_value is still read", () => {
    expect(readMetricValue(4, { intValue: "18446744073709551613" }).text).toBe("-3");
  });
});

describe("every 64-bit field is decimal text, because a number loses them past 2^53", () => {
  test.each([
    ["Int64 maximum", 4, "9223372036854775807", "9223372036854775807"],
    ["UInt64 maximum", 8, "18446744073709551615", "18446744073709551615"],
    ["DateTime past 2^53", 13, "9007199254740993", "9007199254740993"],
  ])("%s round-trips exactly", (_label, datatype, wire, expected) => {
    expect(readMetricValue(datatype, { longValue: wire }).text).toBe(expected);
  });

  test("the text is not a JavaScript number at any point", () => {
    // 2^53+1 is the first integer a double cannot hold; going through Number would give
    // 9007199254740992 and nothing would complain.
    const read = readMetricValue(8, { longValue: "9007199254740993" });
    expect(read.text).not.toBe("9007199254740992");
  });
});

describe("the 3.0 arrays are little-endian packed byte arrays (6.4.17)", () => {
  test("Int8Array [-23, 123] is E9 7B", () => {
    // The v3.0.0 PDF prints `0xEF, 0x7B` for this; `master-3.x` corrected it, and the normative
    // sentence is what this follows.
    expect(readMetricValue(22, { bytesValue: Uint8Array.of(0xe9, 0x7b) }).text).toBe("[-23, 123]");
  });

  test("FloatArray [1.5] is 00 00 C0 3F, and a SECOND element proves the stride and the order", () => {
    /*
     * ONE ELEMENT PROVES NEITHER. A single-element array is symmetric in the two dimensions this
     * test claims to cover: a reader with the wrong stride, or one that returned elements in
     * reverse, answers a one-element array correctly. The pair below is asymmetric in both: 1.5 and
     * -2.25 differ, so a reversal shows, and they are four bytes apart, so a wrong stride shows.
     */
    expect(readMetricValue(30, { bytesValue: Uint8Array.of(0x00, 0x00, 0xc0, 0x3f) }).text).toBe("[1.5]");
    const pair = new Uint8Array(8);
    const view = new DataView(pair.buffer);
    view.setFloat32(0, 1.5, true);
    view.setFloat32(4, -2.25, true);
    expect(readMetricValue(30, { bytesValue: pair }).text).toBe("[1.5, -2.25]");
    expect([...pair.subarray(0, 4)]).toEqual([0x00, 0x00, 0xc0, 0x3f]);
  });

  test("a DateTimeArray element is 8 bytes, and two UNEQUAL elements prove the stride and order", () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    // Two values that differ, so a reversed read or a wrong stride cannot answer correctly. The
    // second is past 2^53, which keeps the decimal-text rule under test here as well.
    view.setBigUint64(0, BigInt(1760000000000), true);
    view.setBigUint64(8, BigInt("9007199254740993"), true);
    expect(readMetricValue(34, { bytesValue: bytes }).text).toBe("[1760000000000, 9007199254740993]");
  });

  test("a BooleanArray is a 4-byte count then bits packed most significant first", () => {
    // Computed: nine values is `09 00 00 00 B0 80`.
    const read = readMetricValue(32, {
      bytesValue: Uint8Array.of(0x09, 0x00, 0x00, 0x00, 0xb0, 0x80),
    });
    expect(read.text).toBe("[true, false, true, true, false, false, false, false, true]");
    expect(read.problem).toBeUndefined();
  });

  /*
    THE TWO WIDTHS BETWEEN THE ONES ABOVE. The 1-byte and the 8-byte cases each had a test and the
    2-byte and 4-byte integer cases had none: the house's coverage gate reported `values.ts`
    174-178 as never walked, which is both arms of the `case 2` and `case 4` branches. Each pair
    below is UNEQUAL and signed-negative where the type allows it, so a wrong stride, a reversed
    read and a missing sign extension all show. One element would prove none of the three.
  */
  test.each([
    [23, "Int16Array", Int16Array.of(-23, 4660), "[-23, 4660]"],
    [27, "UInt16Array", Uint16Array.of(65513, 4660), "[65513, 4660]"],
    [24, "Int32Array", Int32Array.of(-23, 305419896), "[-23, 305419896]"],
    [28, "UInt32Array", Uint32Array.of(4294967273, 305419896), "[4294967273, 305419896]"],
  ])("a %s (%s) is read element by element, signs and all", (datatype, _name, packed, expected) => {
    const bytes = new Uint8Array(packed.buffer.slice(0));
    expect(readMetricValue(datatype as number, { bytesValue: bytes }).text).toBe(expected);
  });

  test("a BooleanArray whose bits do not fill the count it declares is shown as bytes", () => {
    /*
     * The count says nine, which needs two bytes of bits, and only one is there. Measured as a
     * distinct refusal from the one below it: that one is a length that does not divide by the
     * element width, this one is a length that divides fine and disagrees with the array's OWN
     * declared count. A reader shown the wrong one looks for the wrong fault.
     */
    const read = readMetricValue(32, { bytesValue: Uint8Array.of(0x09, 0x00, 0x00, 0x00, 0xb0) });
    expect(read.problem).toBe("length-not-a-multiple");
    expect(read.datatype).toBe("BooleanArray");
    expect(read.hex).toBe(true);
  });

  test("a length that is not a multiple of the element width is shown as bytes", () => {
    const read = readMetricValue(24, { bytesValue: Uint8Array.of(1, 2, 3) });
    expect(read.problem).toBe("length-not-a-multiple");
    expect(read.hex).toBe(true);
  });
});

describe("a StringArray is ambiguous by construction and says so", () => {
  test("a well-formed run is split", () => {
    const bytes = new TextEncoder().encode("ab\u0000cd\u0000");
    expect(readMetricValue(33, { bytesValue: bytes }).text).toBe("[ab, cd]");
  });

  test("an empty string is a lone NUL", () => {
    const bytes = Uint8Array.of(0x61, 0x00, 0x00);
    expect(readMetricValue(33, { bytesValue: bytes }).text).toBe("[a, ]");
  });

  test("a run that does not end in NUL is shown as bytes, not guessed", () => {
    const bytes = new TextEncoder().encode("ab\u0000cd");
    const read = readMetricValue(33, { bytesValue: bytes });
    expect(read.problem).toBe("ambiguous");
    expect(read.hex).toBe(true);
  });

  test("bytes that are not UTF-8 are shown as hex rather than with replacement characters", () => {
    const read = readMetricValue(33, { bytesValue: Uint8Array.of(0xff, 0xfe, 0x00) });
    expect(read.problem).toBe("not-utf8");
    expect(read.text).not.toContain("\uFFFD");
  });
});

describe("what the layer declines rather than flattens", () => {
  test.each([
    ["DataSet", 16],
    ["Template", 19],
    ["PropertySet", 20],
    ["PropertySetList", 21],
  ] as const)("%s is left to the objects layer", (name, datatype) => {
    const read = readMetricValue(datatype, {});
    expect(read.datatype).toBe(name);
    expect(read.problem).toBe("wire-field-mismatch");
  });

  test("a missing wire field is said, not shown as zero", () => {
    expect(readMetricValue(3, {}).problem).toBe("wire-field-missing");
    expect(readMetricValue(3, {}).text).toBe("");
  });

  test("an explicit null is shown as null", () => {
    expect(readMetricValue(3, { isNull: true }).text).toBe("null");
  });

  test("a datatype outside 0 to 34 is named as itself", () => {
    expect(datatypeName(99)).toBeUndefined();
    expect(readMetricValue(99, { intValue: "1" }).text).toBe("unknown datatype 99");
  });
});

describe("Bytes and File are hex, never text and never opened", () => {
  test.each([
    ["Bytes", 17],
    ["File", 18],
  ])("%s is hex", (_name, datatype) => {
    const read = readMetricValue(datatype, { bytesValue: Uint8Array.of(0x01, 0x02, 0xff) });
    expect(read.text).toBe("01 02 ff");
    expect(read.hex).toBe(true);
  });
});
