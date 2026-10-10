/**
 * Text helpers of the S3 preview: the UTF-8 back-off of a ranged read (RFC 3629),
 * Oxia's printable rule, the whitespace-only JSON re-indent that never rounds an integer and stops at its
 * limit in one pass, and Go's hex.Dumper layout, byte for byte.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeText,
  hexDump,
  hexRows,
  isPrintableText,
  reindentJson,
  textLines,
  utf8BackOff,
} from "@/lib/db/providers/objectstore/s3/preview-text";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const heapUsed = (): number => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

describe("utf8BackOff", () => {
  test("keeps every whole 2-, 3- and 4-byte sequence at every cut offset of a mixed text", () => {
    const whole = utf8("aé€\u{1F600}b");
    const boundaries = [0, 1, 3, 6, 10, 11];
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const kept = utf8BackOff(whole.subarray(0, cut));
      const expected = Math.max(...boundaries.filter((boundary) => boundary <= cut));
      expect(kept.length, `cut at ${cut}`).toBe(expected);
    }
  });

  test("a read ending in C3 A9 keeps both bytes, and one ending in E2 82 drops both", () => {
    expect(utf8BackOff(bytes(0x61, 0xc3, 0xa9))).toEqual(bytes(0x61, 0xc3, 0xa9));
    expect(utf8BackOff(bytes(0x61, 0xe2, 0x82))).toEqual(bytes(0x61));
  });

  test("an invalid tail is kept for the printable test to refuse", () => {
    expect(utf8BackOff(bytes(0x61, 0x80, 0x80, 0x80, 0x80))).toEqual(bytes(0x61, 0x80, 0x80, 0x80, 0x80));
    expect(utf8BackOff(bytes(0x61, 0xff))).toEqual(bytes(0x61, 0xff));
    expect(utf8BackOff(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});

describe("isPrintableText and decodeText (Oxia's rule)", () => {
  test("tab, LF and CR are kept", () => {
    expect(isPrintableText(utf8("a\tb\nc\r\n"))).toBe(true);
  });

  test("0x00, 0x1B and 0x7F are refused, and so is invalid UTF-8", () => {
    expect(isPrintableText(bytes(0x61, 0x00))).toBe(false);
    expect(isPrintableText(bytes(0x61, 0x1b))).toBe(false);
    expect(isPrintableText(bytes(0x61, 0x7f))).toBe(false);
    expect(isPrintableText(bytes(0x61, 0xc3))).toBe(false);
  });

  test("a leading byte order mark stays in the text", () => {
    expect(isPrintableText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe(true);
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe("\uFEFFa");
  });
});

describe("reindentJson", () => {
  test("minified input gives the two-space layout, and an empty object or array stays on one line", () => {
    expect(reindentJson('{"a":[1,2],"b":{},"c":[]}', 1_000)).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {},\n  "c": []\n}',
    );
  });

  test("bytes inside strings and numbers never change", () => {
    const text = '{"k":"a{b\\"c,d:e\\u00e9 ","n":123456789012345678901234567890}';
    expect(reindentJson(text, 1_000)).toBe(
      '{\n  "k": "a{b\\"c,d:e\\u00e9 ",\n  "n": 123456789012345678901234567890\n}',
    );
  });

  test("already-indented input comes back unchanged, and loose whitespace is removed", () => {
    const indented = JSON.stringify({ a: [1, { b: null, c: true }], d: "x" }, null, 2);
    expect(reindentJson(indented, 1_000)).toBe(indented);
    expect(reindentJson(" [ 1 ,\t2 ]\n", 1_000)).toBe("[\n  1,\n  2\n]");
  });

  test("output one character over the limit gives undefined, and exactly at it the text", () => {
    const out = "[\n  1,\n  2\n]";
    expect(reindentJson("[1,2]", out.length)).toBe(out);
    expect(reindentJson("[1,2]", out.length - 1)).toBeUndefined();
  });

  test("a 999,998-byte document nested 499,999 deep returns undefined within one second and under 64 MiB of heap", () => {
    const text = `${"[".repeat(499_999)}${"]".repeat(499_999)}`;
    const before = heapUsed();
    const started = performance.now();
    expect(reindentJson(text, 1_000_000)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(heapUsed() - before).toBeLessThan(64 * 1_048_576);
  });
});

describe("hexDump: Go's hex.Dumper layout", () => {
  const line = (offset: string, hex: string, chars: string): string => `${offset}  ${hex.padEnd(49, " ")} |${chars}|\n`;

  test("0 bytes give no line", () => {
    expect(hexDump(new Uint8Array(0), 0)).toBe("");
  });

  test("1 byte", () => {
    expect(hexDump(bytes(0x41), 1)).toBe(`00000000  41${" ".repeat(48)}|A|\n`);
  });

  test("15 and 16 bytes", () => {
    const sixteen = Uint8Array.from({ length: 16 }, (_, index) => 0x41 + index);
    expect(hexDump(sixteen.subarray(0, 15), 15)).toBe(
      line("00000000", "41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f ", "ABCDEFGHIJKLMNO"),
    );
    expect(hexDump(sixteen, 16)).toBe(
      "00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|\n",
    );
  });

  test("17 bytes: one full line, then the last padded to the full width (Oxia's measured vector)", () => {
    const seventeen = Uint8Array.from({ length: 17 }, (_, index) => 0x41 + index);
    expect(hexDump(seventeen, 17)).toBe(
      "00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|\n" +
        "00000010  51                                                |Q|\n",
    );
  });

  test("40 bytes of an object of 100,000 bytes end with the line that says how many are shown", () => {
    const forty = Uint8Array.from({ length: 40 }, (_, index) => index);
    const dump = hexDump(forty, 100_000);
    const lines = dump.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|");
    expect(lines[2]).toBe(`00000020  20 21 22 23 24 25 26 27${" ".repeat(27)}| !"#$%&'|`);
    expect(lines[3]).toBe("The first 40 of 100,000 bytes are shown.");
    expect(lines[4]).toBe("");
  });

  test("the vector measured against Oxia's hex dump, byte for byte", () => {
    expect(hexDump(bytes(0x00, 0x01, 0x02, 0xff, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79), 10)).toBe(
      "00000000  00 01 02 ff 62 69 6e 61  72 79                    |....binary|\n",
    );
  });
});

describe("hexRows and textLines (console rows)", () => {
  test("hex rows of 16 bytes: offset, pairs separated by spaces, the dump's character column", () => {
    const rows = hexRows(
      Uint8Array.from({ length: 20 }, (_, index) => 0x41 + index),
      500,
    );
    expect(rows.more).toBe(false);
    expect(rows.rows).toEqual([
      ["00000000", "41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50", "ABCDEFGHIJKLMNOP"],
      ["00000010", "51 52 53 54", "QRST"],
    ]);
  });

  test("hex rows stop at maxRows and say there are more", () => {
    const rows = hexRows(new Uint8Array(48), 2);
    expect(rows.rows).toHaveLength(2);
    expect(rows.more).toBe(true);
  });

  test("text lines: LF and CRLF, a final LF adds no line, and the cap", () => {
    expect(textLines("a\r\nb\nc\n", 10)).toEqual({ lines: ["a", "b", "c"], more: false });
    expect(textLines("a\nb\nc", 2)).toEqual({ lines: ["a", "b"], more: true });
  });
});
