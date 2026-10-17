/**
 * The BER reader's bounds, one case per bound.
 *
 * This file exists because of a mutation run. Measured on 13 October 2026: deleting the
 * indefinite-length refusal left the valve's suite green, and so did deleting the value-past-end
 * check, and so did deleting both together. Every malformed input the valve carried was being
 * refused by some other bound, so "it was refused" was true and told us nothing about which
 * bound did it. Each test below names the bound it is about and asserts on that bound's own
 * message, so a deleted check shows up as a failure here rather than as silence.
 */
import { describe, expect, test } from "bun:test";
import { BerError, readChildren, readField, writeOid } from "@/lib/db/providers/network/snmp/ber";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("a well formed field reads back", () => {
  test("tag, start and end", () => {
    const field = readField(bytes(0x30, 0x03, 0x02, 0x01, 0x07), 0);
    expect(field).toEqual({ tag: 0x30, start: 2, end: 5 });
  });
  test("its children", () => {
    const buffer = bytes(0x30, 0x03, 0x02, 0x01, 0x07);
    const children = readChildren(buffer, readField(buffer, 0));
    expect(children.map((c) => c.tag)).toEqual([0x02]);
  });
  test("a two octet length", () => {
    const buffer = new Uint8Array(4 + 200);
    buffer[0] = 0x30;
    buffer[1] = 0x82;
    buffer[2] = 0x00;
    buffer[3] = 0xc8;
    const field = readField(buffer, 0);
    expect(field.end - field.start).toBe(200);
  });
});

describe("each bound refuses on its own", () => {
  const cases: ReadonlyArray<readonly [string, string, () => unknown]> = [
    ["the indefinite form", "indefinite", () => readField(bytes(0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00), 0)],
    ["a value past the end", "value past end", () => readField(bytes(0x30, 0x7f, 0x02, 0x01, 0x01), 0)],
    ["a length octet past the end", "length octet past end", () => readField(bytes(0x30), 0)],
    ["length octets past the end", "length octets past end", () => readField(bytes(0x30, 0x84, 0x00), 0)],
    [
      "a length longer than four octets",
      "longer than any SNMP message",
      () => readField(bytes(0x30, 0x88, 1, 2, 3, 4, 5, 6, 7, 8), 0),
    ],
    ["a field starting past the end", "field past end", () => readField(bytes(0x30, 0x01, 0x05), 9)],
    [
      "a child running past its parent",
      "past its parent",
      () => readChildren(bytes(0x30, 0x02, 0x02, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05), { tag: 0x30, start: 2, end: 4 }),
    ],
  ];
  for (const [what, fragment, run] of cases) {
    test(what, () => {
      expect(run).toThrow(BerError);
      expect(run).toThrow(fragment);
    });
  }
  test("more fields than one SEQUENCE may hold", () => {
    const content: number[] = [];
    for (let i = 0; i < 10; i += 1) content.push(0x02, 0x01, i);
    const buffer = new Uint8Array([0x30, content.length, ...content]);
    const run = () => readChildren(buffer, readField(buffer, 0));
    expect(run).toThrow(BerError);
    expect(run).toThrow("more than 8 fields");
  });
});

describe("an object identifier this encoder will not write", () => {
  test("a sub-identifier outside the range RFC 2578 allows is refused by name", () => {
    // 2^32 - 1 is the largest an arc may be (section 3.5). The refusal exists so a value that
    // cannot be a sub-identifier is named here rather than encoded into bytes an agent would
    // read as some other arc entirely.
    expect(() => writeOid([1, 3, 6, 1, 4294967296])).toThrow(BerError);
    expect(() => writeOid([1, 3, 6, 1, -1])).toThrow(/sub-identifier/);
    expect(() => writeOid([1, 3, 6, 1, 1.5])).toThrow(/sub-identifier/);
  });
});
