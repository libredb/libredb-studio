/**
 * An Oxia value in a cell and in the Source tab (SB2-6.2 to SB2-6.4), a key in a sentence (SB2-6.5) and a version
 * timestamp in a cell (SB2-6.1): the classifier's four rules in order, the cell bound, the CLI's hex dump byte for
 * byte, and the 64 KiB dump bound with its sentence.
 */
import { describe, expect, test } from "bun:test";
import { OXIA_CELL_LIMIT, OXIA_SOURCE_HEX_BYTES } from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  hexDump,
  isoFromEpochMs,
  isPrintableText,
  shownKey,
  viewOxiaValue,
  WITHHELD_VALUE_TEXT,
} from "@/lib/db/providers/keyvalue/oxia/values";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const view = (bytes: Uint8Array, hex = false) => viewOxiaValue(bytes, { hex, cellLimit: OXIA_CELL_LIMIT });

describe("viewOxiaValue: the four rules, first match wins (SB2-6.2)", () => {
  test("1. --hex shows the value as hex whatever it holds", () => {
    expect(view(utf8('{"a":1}'), true)).toEqual({ text: "7b2261223a317d", encoding: "hex", byteLength: 7, cut: false });
  });

  test("2. bytes that are not UTF-8 are hex: a lone 0xC3", () => {
    expect(view(Uint8Array.of(0x61, 0xc3))).toEqual({ text: "61c3", encoding: "hex", byteLength: 2, cut: false });
  });

  test("3. UTF-8 that is not printable text is hex: a Pulsar ledger flag, NUL and DEL", () => {
    expect(view(Uint8Array.of(0x08, 0x01))).toEqual({ text: "0801", encoding: "hex", byteLength: 2, cut: false });
    expect(view(utf8("a\u0000b")).encoding).toBe("hex");
    expect(view(utf8("a\u007fb")).encoding).toBe("hex");
    expect(view(utf8("a\u001bb")).encoding).toBe("hex");
  });

  test("4. printable text that JSON.parse reads is json: an object, a scalar", () => {
    expect(view(utf8('{"policy":"allow"}'))).toEqual({
      text: '{"policy":"allow"}',
      encoding: "json",
      byteLength: 18,
      cut: false,
    });
    expect(view(utf8("123")).encoding).toBe("json");
    expect(view(utf8(" true ")).encoding).toBe("json");
  });

  test("5. any other printable text is text: tab, LF and CR are kept as text", () => {
    expect(view(utf8("a\tb\nc\r\nd"))).toEqual({ text: "a\tb\nc\r\nd", encoding: "text", byteLength: 8, cut: false });
    expect(view(utf8("café 𝄞")).encoding).toBe("text");
  });

  test("an empty value is text with an empty cell", () => {
    expect(view(new Uint8Array(0))).toEqual({ text: "", encoding: "text", byteLength: 0, cut: false });
  });

  test("a leading U+FEFF is kept as the value's own character", () => {
    expect(view(utf8("﻿a")).text).toBe("﻿a");
  });
});

describe("isPrintableText", () => {
  test.each([
    ["text with tab, LF and CR", utf8("a\tb\nc\r"), true],
    ["the empty value", new Uint8Array(0), true],
    ["a Pulsar ledger flag", Uint8Array.of(0x08, 0x01), false],
    ["NUL", Uint8Array.of(0x00), false],
    ["DEL", Uint8Array.of(0x7f), false],
    ["a lone 0xC3", Uint8Array.of(0xc3), false],
    ["a C1 control written as UTF-8", utf8("\u0085"), true],
  ])("%s", (_name, bytes, expected) => {
    expect(isPrintableText(bytes)).toBe(expected);
  });
});

describe("the cell bound (SB2-6.3)", () => {
  test("a text value at the bound is whole, one past it is cut there", () => {
    const at = "a".repeat(OXIA_CELL_LIMIT);
    expect(view(utf8(at))).toEqual({ text: at, encoding: "text", byteLength: OXIA_CELL_LIMIT, cut: false });
    const past = view(utf8(`${at}b`));
    expect([past.text.length, past.encoding, past.cut, past.byteLength]).toEqual([
      OXIA_CELL_LIMIT,
      "text",
      true,
      OXIA_CELL_LIMIT + 1,
    ]);
  });

  test("a cut never splits a surrogate pair: it steps back over the high half", () => {
    const text = `${"a".repeat(OXIA_CELL_LIMIT - 1)}𝄞`;
    const cut = view(utf8(text));
    expect(cut.text).toBe("a".repeat(OXIA_CELL_LIMIT - 1));
    expect(cut.cut).toBe(true);
  });

  test("a json value cut at the bound keeps its encoding, which the grid writes with , cut", () => {
    const json = JSON.stringify({ data: "x".repeat(OXIA_CELL_LIMIT) });
    expect(view(utf8(json))).toMatchObject({ encoding: "json", cut: true });
  });

  test("a hex cell shows the first 32,768 bytes", () => {
    const bytes = new Uint8Array(OXIA_CELL_LIMIT / 2 + 1).fill(0x01);
    const cell = view(bytes);
    expect([cell.text.length, cell.encoding, cell.cut, cell.byteLength]).toEqual([
      OXIA_CELL_LIMIT,
      "hex",
      true,
      OXIA_CELL_LIMIT / 2 + 1,
    ]);
    expect(view(bytes.subarray(1)).cut).toBe(false);
  });

  test("an odd bound shows whole bytes only, so a cut never splits a byte's two digits", () => {
    expect(viewOxiaValue(Uint8Array.of(0x01, 0x02, 0x03), { hex: false, cellLimit: 5 })).toEqual({
      text: "0102",
      encoding: "hex",
      byteLength: 3,
      cut: true,
    });
  });

  test("Infinity is no bound, and any other bound that is not a whole number from 1 is refused", () => {
    const long = utf8("a".repeat(OXIA_CELL_LIMIT * 2));
    expect(viewOxiaValue(long, { hex: false, cellLimit: Number.POSITIVE_INFINITY }).cut).toBe(false);
    for (const cellLimit of [0, -1, 1.5, Number.NaN]) {
      expect(() => viewOxiaValue(long, { hex: false, cellLimit })).toThrow(
        "The cell bound is a whole number of characters, 1 or more, or Infinity for none",
      );
    }
  });
});

describe("hexDump: Go's hex.Dumper layout (SB2-6.4)", () => {
  test("the measured vector of R07 M3, byte for byte", () => {
    const bytes = Uint8Array.of(0x00, 0x01, 0x02, 0xff, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79);
    expect(hexDump(bytes, OXIA_SOURCE_HEX_BYTES)).toBe(
      "00000000  00 01 02 ff 62 69 6e 61  72 79                    |....binary|\n",
    );
  });

  test("17 bytes: one full line, then the last padded to the full width", () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, index) => 0x41 + index);
    expect(hexDump(bytes, OXIA_SOURCE_HEX_BYTES)).toBe(
      "00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|\n" +
        "00000010  51                                                |Q|\n",
    );
  });

  test("the right column shows 0x20 to 0x7E as themselves and every other byte as a dot", () => {
    expect(hexDump(Uint8Array.of(0x1f, 0x20, 0x7e, 0x7f, 0x80), OXIA_SOURCE_HEX_BYTES)).toBe(
      "00000000  1f 20 7e 7f 80                                    |. ~..|\n",
    );
  });

  test("an empty value dumps nothing", () => {
    expect(hexDump(new Uint8Array(0), OXIA_SOURCE_HEX_BYTES)).toBe("");
  });

  test("past 65,536 bytes the dump stops and says how many of how many are shown", () => {
    const bytes = new Uint8Array(OXIA_SOURCE_HEX_BYTES + 100);
    const dump = hexDump(bytes, OXIA_SOURCE_HEX_BYTES);
    const lines = dump.split("\n");
    // 4,096 lines of 16 bytes, the sentence, and the empty string after the last LF.
    expect(lines).toHaveLength(OXIA_SOURCE_HEX_BYTES / 16 + 2);
    expect(lines[OXIA_SOURCE_HEX_BYTES / 16 - 1].startsWith("0000fff0  ")).toBe(true);
    expect(lines[OXIA_SOURCE_HEX_BYTES / 16]).toBe("The first 65,536 of 65,636 bytes are shown.");
    expect(hexDump(bytes.subarray(0, OXIA_SOURCE_HEX_BYTES), OXIA_SOURCE_HEX_BYTES)).not.toContain("are shown");
  });
});

describe("shownKey (SB2-6.5)", () => {
  test.each([
    ["/admin/policies/public", "/admin/policies/public"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ["", "''"],
    ["a\rb", '"a\\rb"'],
    ["a\u0000b", '"a\\u0000b"'],
    ["a\ud800", '"a\\ud800"'],
    ["a\udc00", '"a\\udc00"'],
  ])("%j is written %s", (key, shown) => {
    expect(shownKey(key)).toBe(shown);
  });

  test("a key longer than 120 characters is cut there, between two characters, with ...", () => {
    expect(shownKey("k".repeat(121))).toBe(`${"k".repeat(120)}...`);
    expect(shownKey("k".repeat(120))).toBe("k".repeat(120));
    const astral = shownKey(`${"k".repeat(119)}𝄞𝄞`);
    expect(astral).toBe(`${"k".repeat(119)}𝄞...`);
  });

  test("the cut counts the spelled form, quotes included, so a notice stays one line", () => {
    const key = `a b${"k".repeat(116)}`;
    expect(shownKey(key)).toBe(`'a b${"k".repeat(116)}...`);
  });
});

describe("isoFromEpochMs (SB2-6.1)", () => {
  test.each([
    ["0", "1970-01-01T00:00:00.000Z"],
    ["1791067058375", "2026-10-03T22:37:38.375Z"],
    ["8640000000000000", "+275760-09-13T00:00:00.000Z"],
    ["8640000000000001", "8640000000000001 ms"],
    ["18446744073709551615", "18446744073709551615 ms"],
  ])("%s is %s", (ms, shown) => {
    expect(isoFromEpochMs(ms)).toBe(shown);
  });

  test.each(["", "-1", "01", "1.5", "1e3", " 1"])("%j is no decimal string, and throws", (ms) => {
    expect(() => isoFromEpochMs(ms)).toThrow("An Oxia timestamp is a decimal string of epoch milliseconds");
  });
});

describe("WITHHELD_VALUE_TEXT", () => {
  test("is the withheld cell's sentence of SB2-6.2", () => {
    expect(WITHHELD_VALUE_TEXT).toBe("value larger than 16 MiB, withheld");
  });
});
