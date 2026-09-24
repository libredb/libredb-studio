import { describe, expect, test } from "bun:test";
import { decodeBytes, decodeHeaderName } from "@/lib/db/providers/stream/kafka/decode";

const bytes = (s: string) => new TextEncoder().encode(s);

/** The UTF-8 byte order mark, EF BB BF. */
const BOM = [0xef, 0xbb, 0xbf];

/** U+1F600, a four-byte UTF-8 character (F0 9F 98 80) and a UTF-16 surrogate pair. */
const FOUR_BYTE = "\u{1F600}";

describe("decodeBytes", () => {
  test("null stays null", () => {
    expect(decodeBytes(null, 100)).toEqual({ value: null, encoding: "null", truncated: false });
  });

  test("a JSON object or array is parsed", () => {
    expect(decodeBytes(bytes('{"id":25,"note":"ü 日本"}'), 1000)).toMatchObject({
      value: { id: 25, note: "ü 日本" },
      encoding: "json",
    });
    expect(decodeBytes(bytes("[1,2]"), 1000).encoding).toBe("json");
  });

  test("a JSON scalar is text, not json: a bare 42 or true reads better as what was sent", () => {
    expect(decodeBytes(bytes("42"), 1000)).toMatchObject({ value: "42", encoding: "text" });
  });

  test("text that opens like JSON but does not parse is text", () => {
    expect(decodeBytes(bytes("{not json"), 100)).toMatchObject({
      value: "{not json",
      encoding: "text",
      truncated: false,
    });
  });

  test("valid UTF-8 that is not JSON is text", () => {
    expect(decodeBytes(bytes("plain text line"), 1000)).toMatchObject({ value: "plain text line", encoding: "text" });
  });

  test("a leading byte order mark is kept as sent, so the value is text and never parsed as JSON", () => {
    const decoded = decodeBytes(new Uint8Array([...BOM, ...bytes('{"a":1}')]), 1000);
    expect(decoded).toEqual({ value: '\uFEFF{"a":1}', encoding: "text", truncated: false });
  });

  test("invalid UTF-8 is base64 with its byte length, never a replacement character", () => {
    const cell = decodeBytes(new Uint8Array([0xff, 0xfe, 0x01]), 1000);
    expect(cell.encoding).toBe("base64");
    expect(cell.value).toBe("//4B (3 bytes)");
  });

  test("the Confluent wire format is labelled with its schema id and not decoded", () => {
    const framed = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x2a, 0x7b, 0x7d]);
    expect(decodeBytes(framed, 1000)).toMatchObject({ value: "schema id 42, not decoded", encoding: "confluent" });
  });

  test("the schema id is read at the view's own offset, not at the start of the underlying buffer", () => {
    const backing = new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x7b]);
    expect(decodeBytes(backing.subarray(2), 1000)).toMatchObject({
      value: "schema id 256, not decoded",
      encoding: "confluent",
    });
  });

  test("the stated false positive: a text value starting with NUL and at least 5 bytes long reads as confluent", () => {
    expect(decodeBytes(new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x44]), 1000).encoding).toBe("confluent");
  });

  test("four bytes starting with NUL are too short for the framing and decode as text", () => {
    expect(decodeBytes(new Uint8Array([0x00, 0x41, 0x42, 0x43]), 1000).encoding).toBe("text");
  });

  test("a text cell past the limit is truncated and says so", () => {
    expect(decodeBytes(bytes("x".repeat(50)), 10)).toMatchObject({
      value: "xxxxxxxxxx",
      encoding: "text",
      truncated: true,
    });
  });

  test("the cell cut never keeps half of a surrogate pair, which would render as a character never sent", () => {
    // a, U+1F600, b is a, then the two UTF-16 code units of U+1F600, then b: a cut at 2 would end inside the pair.
    expect(decodeBytes(bytes(`a${FOUR_BYTE}b`), 2)).toEqual({ value: "a", encoding: "text", truncated: true });
    expect(decodeBytes(bytes(`["${FOUR_BYTE}${FOUR_BYTE}"]`), 3)).toEqual({
      value: '["',
      encoding: "json",
      truncated: true,
    });
  });

  test("JSON past the cell limit but within the prefix bound keeps its label, and its cut text is shown", () => {
    const json = decodeBytes(bytes(`{"a":"${"y".repeat(30)}"}`), 20);
    expect(json).toMatchObject({ encoding: "json", truncated: true });
    expect(json.value).toBe(`{"a":"${"y".repeat(14)}`);
  });

  test("a value past the prefix bound is judged on its first bytes: never parsed as JSON", () => {
    expect(decodeBytes(bytes(`{"a":"${"y".repeat(60)}"}`), 10)).toMatchObject({ encoding: "text", truncated: true });
  });

  test("the prefix decides validity: an invalid byte past it is not seen", () => {
    expect(decodeBytes(new Uint8Array([...bytes("a".repeat(20)), 0xff]), 2)).toMatchObject({
      value: "aa",
      encoding: "text",
    });
  });

  test("the cut backs off to a character boundary instead of splitting a multi-byte character", () => {
    // "aéé" is 61 C3 A9 C3 A9: a cut at 4 bytes would end inside the second é and fail as UTF-8.
    expect(decodeBytes(bytes("aéé"), 1)).toMatchObject({ value: "a", encoding: "text", truncated: true });
  });

  test("the back-off covers a four-byte character cut after its third byte", () => {
    // a, U+1F600, a is 61 F0 9F 98 80 61: a cut at 4 bytes ends two continuation bytes into U+1F600.
    expect(decodeBytes(bytes(`a${FOUR_BYTE}a`), 1)).toMatchObject({ value: "a", encoding: "text", truncated: true });
  });

  test("a long invalid value is the base64 of a prefix, with the whole length stated", () => {
    // 20 characters hold the 11-character suffix " (40 bytes)" and two whole 3-byte groups.
    expect(decodeBytes(new Uint8Array(40).fill(0xff), 20)).toEqual({
      value: "//////// (40 bytes)",
      encoding: "base64",
      truncated: true,
    });
    expect(decodeBytes(new Uint8Array(4).fill(0xff), 100).value).toBe("/////w== (4 bytes)");
  });

  test("the base64 of a view encodes the view's own bytes, not the underlying buffer's", () => {
    const backing = new Uint8Array([0x41, 0x41, 0xff, 0xfe, 0x01, 0x41]);
    expect(decodeBytes(backing.subarray(2, 5), 100).value).toBe("//4B (3 bytes)");
  });

  test("at the provider's 64 KiB cell limit the length suffix is never cut, and the cut ends on a whole group", () => {
    const limit = 64 * 1024;
    // 49,140 bytes are 16,380 groups: 65,520 characters of base64 beside a 14-character suffix.
    for (const length of [49_140, 49_141, 49_147, 49_152, 65_536, 1_000_000]) {
      const decoded = decodeBytes(new Uint8Array(length).fill(0xff), limit);
      const value = decoded.value as string;
      expect(decoded.encoding).toBe("base64");
      expect(value).toEndWith(` (${length} bytes)`);
      expect(value.length).toBeLessThanOrEqual(limit);
      expect(decoded.truncated).toBe(length > 49_140);
      expect(value.slice(0, value.indexOf(" "))).not.toContain("=");
    }
  });
});

describe("decodeHeaderName", () => {
  test("a name is text, never JSON and never a Confluent frame", () => {
    expect(decodeHeaderName(bytes('{"a":1}'), 100)).toMatchObject({ value: '{"a":1}', encoding: "text" });
    expect(decodeHeaderName(new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x44]), 100).encoding).toBe("text");
  });

  test("a name that is not UTF-8 is base64, and a null name is null", () => {
    expect(decodeHeaderName(new Uint8Array([0xff]), 100).value).toBe("/w== (1 bytes)");
    expect(decodeHeaderName(null, 100)).toEqual({ value: null, encoding: "null", truncated: false });
  });

  test("a name with a leading byte order mark stays apart from the same name without one", () => {
    const marked = decodeHeaderName(new Uint8Array([...BOM, ...bytes("trace")]), 100);
    expect(marked.value).toBe("\uFEFFtrace");
    expect(marked.value).not.toBe(decodeHeaderName(bytes("trace"), 100).value);
  });
});
