/**
 * What one side handed is compared deep-equal with what the other side decoded, and whatever the value codec's JSON
 * round trip changes or drops is refused by name (docs/providers/CONTRACT.md, clause C-21).
 *
 * Each admitted case is compared against its own encode, stringify, parse and decode, as a frame carries it; each
 * refused case either crosses the same way or is a synthetic pair whose received side differs in one place.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type FrameRefusal, type RoundTripAt, roundTripRefusals } from "@libredb/provider-sdk/testing";
import { decodeValue, encodeValue } from "@libredb/provider-sdk/values";

const AT: RoundTripAt = { call: "console.execute", part: "request" };

/** `value` as the other side of a frame decodes it. */
function cross(value: unknown): unknown {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
}

function changed(...pointers: string[]): FrameRefusal[] {
  return pointers.map((pointer) => ({ rule: "round-trip-changed", call: "console.execute", part: "request", pointer }));
}

class Bytes extends Uint8Array {}
class Stamp extends Date {}

describe("roundTripRefusals", () => {
  test("a value the codec carries is admitted, with -0, a Buffer, a null-prototype object and Date and Uint8Array subclasses compared as the codec defines them", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: [randomUUID()] });
    const value = {
      zero: -0,
      notANumber: Number.NaN,
      infinite: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      wide: BigInt(2) ** BigInt(63),
      buffer: Buffer.from([1, 2, 3]),
      bytes: Bytes.from([4, 5]),
      plain: new Uint8Array([6]),
      stamp: new Stamp(1_700_000_000_000),
      date: new Date(0),
      bare,
      nested: [[1, [2, [randomUUID(), null, true]]], []],
      tagShaped: { $: randomUUID(), v: 1 },
    };

    expect(roundTripRefusals(value, cross(value), AT)).toEqual([]);
    expect(roundTripRefusals(-0, 0, AT)).toEqual([]);
    expect(roundTripRefusals({ a: 1 }, Object.assign(Object.create(null) as object, { a: 1 }), AT)).toEqual([]);
  });

  test("a symbol-keyed property is refused as round-trip-changed at the pointer of the object that holds it", () => {
    const value = { a: { b: 1, [Symbol("s")]: 2, [Symbol("t")]: 3 }, list: Object.assign([1], { [Symbol("u")]: 1 }) };

    expect(roundTripRefusals(value, cross(value), AT)).toEqual(changed("/a", "/list"));
  });

  test("a non-enumerable property is refused as round-trip-changed at its pointer", () => {
    const value = { a: Object.defineProperty({ b: 1 }, "hidden", { value: randomUUID(), enumerable: false }) };

    expect(roundTripRefusals(value, cross(value), AT)).toEqual(changed("/a/hidden"));
  });

  test("an accessor is refused as round-trip-changed at its pointer, and the comparison never calls its getter", () => {
    let reads = 0;
    const value = {
      a: Object.defineProperty({}, "g", {
        enumerable: true,
        get() {
          reads += 1;
          return reads;
        },
      }),
    };
    const received = cross(value);

    expect(reads).toBe(1);
    expect(roundTripRefusals(value, received, AT)).toEqual(changed("/a/g"));
    expect(reads).toBe(1);
  });

  test("an array's own property that is not an index is refused as round-trip-changed at the array", () => {
    const value = { list: Object.assign([1, 2], { extra: randomUUID(), more: 1 }) };

    expect(roundTripRefusals(value, cross(value), AT)).toEqual(changed("/list"));
  });

  test("a received value that differs from the sent one is refused at the pointer where it differs", () => {
    expect(roundTripRefusals({ a: { b: 1 } }, { a: { b: 2 } }, AT)).toEqual(changed("/a/b"));
    expect(roundTripRefusals({ a: 1 }, { a: 1, b: 2 }, AT)).toEqual(changed("/b"));
    expect(roundTripRefusals({ a: 1, b: 2 }, { a: 1 }, AT)).toEqual(changed("/b"));
    expect(roundTripRefusals({ list: [1, 2] }, { list: [1] }, AT)).toEqual(changed("/list"));
    expect(roundTripRefusals([1, [2]], [1, [3]], AT)).toEqual(changed("/1/0"));
    expect(roundTripRefusals(new Uint8Array([1]), new Uint8Array([2]), AT)).toEqual(changed(""));
    expect(roundTripRefusals(new Uint8Array([1]), new Uint8Array([1, 2]), AT)).toEqual(changed(""));
    expect(roundTripRefusals(new Uint8Array([1]), [1], AT)).toEqual(changed(""));
    expect(roundTripRefusals(new Date(0), new Date(1), AT)).toEqual(changed(""));
    expect(roundTripRefusals(new Date(0), 0, AT)).toEqual(changed(""));
    expect(roundTripRefusals({ a: {} }, { a: [] }, AT)).toEqual(changed("/a"));
    expect(roundTripRefusals([], {}, AT)).toEqual(changed(""));
    expect(roundTripRefusals(Number.NaN, 0, AT)).toEqual(changed(""));
    expect(roundTripRefusals(BigInt(1), 1, AT)).toEqual(changed(""));
    expect(roundTripRefusals({ a: 1, skipped: 1 }, { a: 1, other: 2 }, { ...AT, skip: ["skipped", "other"] })).toEqual(
      [],
    );
  });
});
