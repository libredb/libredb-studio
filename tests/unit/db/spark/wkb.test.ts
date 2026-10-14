/** Geometry and geography values: the copied WKB reader, its bounds, and the EWKT text. */
import { describe, expect, spyOn, test } from "bun:test";
import { geoText, wkbToWkt } from "@/lib/db/providers/sql/spark/wkb";

/** WKB built by hand: the byte order (1, little-endian, unless `little` is false), a uint32 type, then the body. */
function wkb(type: number, body: number[], little = true): Uint8Array {
  const head = new DataView(new ArrayBuffer(5));
  head.setUint8(0, little ? 1 : 0);
  head.setUint32(1, type, little);
  return Uint8Array.from([...new Uint8Array(head.buffer), ...body]);
}
/** One float64 in the given byte order, whatever the host's own order. */
function float64(value: number, little: boolean): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, little);
  return Array.from(new Uint8Array(view.buffer));
}
/** A uint32, little-endian unless `little` is false, whatever the host's own order. */
const u32 = (value: number, little = true) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value, little);
  return Array.from(new Uint8Array(view.buffer));
};
const f64 = (...values: number[]) => values.flatMap((value) => float64(value, true));
const f64be = (...values: number[]) => values.flatMap((value) => float64(value, false));
const point = (x: number, y: number) => wkb(1, f64(x, y));
/** Hex of every byte, one byte at a time: an independent reference for the hex that `geoText` writes. */
const hexOf = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("wkbToWkt: the copied reader's forms", () => {
  test("point, empty point, linestring and polygon", () => {
    expect(wkbToWkt(point(1, 2))).toBe("POINT (1 2)");
    expect(wkbToWkt(point(Number.NaN, Number.NaN))).toBe("POINT EMPTY");
    expect(wkbToWkt(wkb(2, [...u32(2), ...f64(0, 0, 1, 1)]))).toBe("LINESTRING (0 0, 1 1)");
    expect(wkbToWkt(wkb(2, u32(0)))).toBe("LINESTRING EMPTY");
    expect(wkbToWkt(wkb(3, [...u32(1), ...u32(4), ...f64(0, 0, 1, 0, 1, 1, 0, 0)]))).toBe(
      "POLYGON ((0 0, 1 0, 1 1, 0 0))",
    );
  });

  test("multi forms and a collection, big-endian parts included", () => {
    const bigEndianPoint = Uint8Array.from([0, 0, 0, 0, 1, ...new Uint8Array(16)]);
    const view = new DataView(bigEndianPoint.buffer, 5);
    view.setFloat64(0, 3, false);
    view.setFloat64(8, 4, false);
    expect(wkbToWkt(wkb(4, [...u32(2), ...point(1, 2), ...bigEndianPoint]))).toBe("MULTIPOINT ((1 2), (3 4))");
    expect(wkbToWkt(wkb(7, [...u32(2), ...point(1, 2), ...wkb(2, [...u32(2), ...f64(0, 0, 1, 1)])]))).toBe(
      "GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))",
    );
  });

  test("multilinestring, multipolygon, a polygon with a hole, and the empty forms", () => {
    const line = (...coordinates: number[]) => wkb(2, [...u32(coordinates.length / 2), ...f64(...coordinates)]);
    const ring = (...coordinates: number[]) => [...u32(coordinates.length / 2), ...f64(...coordinates)];
    expect(wkbToWkt(wkb(5, [...u32(2), ...line(0, 0, 1, 1), ...line(2, 2, 3, 3)]))).toBe(
      "MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))",
    );
    const square = wkb(3, [...u32(1), ...ring(0, 0, 1, 0, 1, 1, 0, 0)]);
    const holed = wkb(3, [...u32(2), ...ring(0, 0, 4, 0, 4, 4, 0, 0), ...ring(1, 1, 2, 1, 2, 2, 1, 1)]);
    expect(wkbToWkt(holed)).toBe("POLYGON ((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1))");
    expect(wkbToWkt(wkb(6, [...u32(2), ...square, ...holed]))).toBe(
      "MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1)))",
    );
    expect(wkbToWkt(wkb(4, [...u32(2), ...point(1, 2), ...point(Number.NaN, Number.NaN)]))).toBe(
      "MULTIPOINT ((1 2), EMPTY)",
    );
    expect(wkbToWkt(wkb(3, u32(0)))).toBe("POLYGON EMPTY");
    expect(wkbToWkt(wkb(4, u32(0)))).toBe("MULTIPOINT EMPTY");
    expect(wkbToWkt(wkb(5, u32(0)))).toBe("MULTILINESTRING EMPTY");
    expect(wkbToWkt(wkb(6, u32(0)))).toBe("MULTIPOLYGON EMPTY");
    expect(wkbToWkt(wkb(7, u32(0)))).toBe("GEOMETRYCOLLECTION EMPTY");
    expect(wkbToWkt(wkb(7, [...u32(2), ...wkb(4, [...u32(1), ...point(1, 2)]), ...wkb(7, u32(0))]))).toBe(
      "GEOMETRYCOLLECTION (MULTIPOINT ((1 2)), GEOMETRYCOLLECTION EMPTY)",
    );
  });

  test("a value that is big-endian throughout reads its counts and coordinates in that order", () => {
    expect(wkbToWkt(wkb(2, [...u32(2, false), ...f64be(0, 0, 1, 1)], false))).toBe("LINESTRING (0 0, 1 1)");
    expect(wkbToWkt(wkb(3, [...u32(1, false), ...u32(4, false), ...f64be(0, 0, 1, 0, 1, 1, 0, 0)], false))).toBe(
      "POLYGON ((0 0, 1 0, 1 1, 0 0))",
    );
    expect(wkbToWkt(wkb(7, [...u32(2, false), ...wkb(1, f64be(1, 2), false), ...point(3, 4)], false))).toBe(
      "GEOMETRYCOLLECTION (POINT (1 2), POINT (3 4))",
    );
  });

  test("a collection nested 64 levels is read, and one nested 65 levels is not decoded", () => {
    let nested = point(1, 2);
    for (let level = 1; level < 64; level += 1) nested = wkb(7, [...u32(1), ...nested]);
    expect(wkbToWkt(nested)).toBe(`${"GEOMETRYCOLLECTION (".repeat(63)}POINT (1 2)${")".repeat(63)}`);
    const deeper = wkb(7, [...u32(1), ...nested]);
    expect(wkbToWkt(deeper)).toBeUndefined();
    expect(geoText(4326, deeper)).toBe(`SRID=4326;WKB(${hexOf(deeper)})`);
  });

  test("a Z or M form, an unknown type, a truncated value and trailing bytes are not decoded", () => {
    expect(wkbToWkt(wkb(1001, f64(1, 2, 3)))).toBeUndefined();
    expect(wkbToWkt(wkb(2001, f64(1, 2, 3)))).toBeUndefined();
    expect(wkbToWkt(wkb(99, []))).toBeUndefined();
    expect(wkbToWkt(wkb(1, f64(1)))).toBeUndefined();
    expect(wkbToWkt(wkb(2, u32(1_000_000)))).toBeUndefined();
    expect(wkbToWkt(Uint8Array.from([...point(1, 2), 0]))).toBeUndefined();
    expect(wkbToWkt(new Uint8Array(0))).toBeUndefined();
  });

  test("type 0, the ZM and extended forms, a count past the end and a truncated part are not decoded", () => {
    expect(wkbToWkt(wkb(0, u32(0)))).toBeUndefined();
    expect(wkbToWkt(wkb(3001, f64(1, 2, 3, 4)))).toBeUndefined();
    expect(wkbToWkt(wkb(0x80000001, f64(1, 2, 3)))).toBeUndefined();
    expect(wkbToWkt(wkb(0x20000001, [...u32(4326), ...f64(1, 2)]))).toBeUndefined();
    for (const type of [2, 3, 4, 7]) expect(wkbToWkt(wkb(type, u32(0xffffffff)))).toBeUndefined();
    expect(wkbToWkt(wkb(3, [...u32(1), ...u32(4), ...f64(0, 0, 1, 0)]))).toBeUndefined();
    expect(wkbToWkt(wkb(7, [...u32(2), ...point(1, 2)]))).toBeUndefined();
  });

  test("a point count that would pass the end is refused before any point is read", () => {
    const read = spyOn(DataView.prototype, "getFloat64");
    try {
      expect(wkbToWkt(wkb(2, [...u32(3), ...f64(0, 0, 1, 1)]))).toBeUndefined();
      expect(wkbToWkt(wkb(3, [...u32(1), ...u32(3), ...f64(0, 0, 1, 0)]))).toBeUndefined();
      expect(wkbToWkt(wkb(2, u32(1_000_000)))).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  test("a ring or part count that cannot fit is refused before any ring or part is read", () => {
    const polygon = wkb(3, u32(0xffffffff));
    const multi = wkb(6, u32(0xffffffff));
    const collection = wkb(7, u32(0xffffffff));
    const allocated = spyOn(Array, "from");
    const orders = spyOn(DataView.prototype, "getUint8");
    let results: (string | undefined)[];
    let allocations: number;
    let orderReads: number;
    try {
      results = [wkbToWkt(polygon), wkbToWkt(multi), wkbToWkt(collection)];
      allocations = allocated.mock.calls.length;
      orderReads = orders.mock.calls.length;
    } finally {
      allocated.mockRestore();
      orders.mockRestore();
    }
    expect(results).toStrictEqual([undefined, undefined, undefined]);
    expect(allocations).toBe(0);
    // Each value reads its own byte order once and no part's.
    expect(orderReads).toBe(3);
  });

  test("a byte order other than 0 or 1 is not decoded", () => {
    const bigEndianPoint = wkb(1, f64be(1, 2), false);
    expect(wkbToWkt(bigEndianPoint)).toBe("POINT (1 2)");
    for (const order of [2, 255]) {
      expect(wkbToWkt(Uint8Array.from([order, ...bigEndianPoint.subarray(1)]))).toBeUndefined();
    }
  });

  test("a multi form holding a part of another type is not decoded", () => {
    const line = wkb(2, [...u32(2), ...f64(0, 0, 1, 1)]);
    expect(wkbToWkt(wkb(4, [...u32(1), ...line]))).toBeUndefined();
    expect(wkbToWkt(wkb(5, [...u32(1), ...point(1, 2)]))).toBeUndefined();
    expect(wkbToWkt(wkb(6, [...u32(1), ...line]))).toBeUndefined();
    expect(wkbToWkt(wkb(4, [...u32(1), ...wkb(7, [...u32(1), ...point(1, 2)])]))).toBeUndefined();
  });
});

describe("geoText", () => {
  test("the SRID= prefix before the WKT", () => {
    expect(geoText(4326, point(1, 2))).toBe("SRID=4326;POINT (1 2)");
    expect(geoText(0, point(-1.5, 2))).toBe("SRID=0;POINT (-1.5 2)");
  });

  test("a form the reader does not decode is written as WKB(<hex>), lossless", () => {
    const z = wkb(1001, f64(1, 2, 3));
    const hex = Array.from(z, (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(geoText(3857, z)).toBe(`SRID=3857;WKB(${hex})`);
  });

  test("every byte value is written as two lower-case hex digits, and an empty value as WKB()", () => {
    expect(geoText(1, Uint8Array.of(0x00, 0x0f, 0xa0, 0xff))).toBe("SRID=1;WKB(000fa0ff)");
    const every = Uint8Array.from({ length: 256 }, (_, byte) => byte);
    expect(wkbToWkt(every)).toBeUndefined();
    expect(geoText(4326, every)).toBe(`SRID=4326;WKB(${hexOf(every)})`);
    expect(geoText(0, new Uint8Array(0))).toBe("SRID=0;WKB()");
  });

  test("a value that is a view into a larger buffer is read from its own offset and length", () => {
    const framed = Uint8Array.from([255, 255, ...point(1, 2), 255]);
    expect(geoText(4326, framed.subarray(2, framed.length - 1))).toBe("SRID=4326;POINT (1 2)");
    const z = wkb(1001, f64(1, 2, 3));
    const framedZ = Uint8Array.from([255, ...z, 255]);
    expect(geoText(3857, framedZ.subarray(1, framedZ.length - 1))).toBe(`SRID=3857;WKB(${hexOf(z)})`);
  });
});
