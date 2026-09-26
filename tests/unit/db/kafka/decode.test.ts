import { describe, expect, test } from "bun:test";
import { decodeBytes, decodeHeaderName } from "@/lib/db/providers/stream/kafka/decode";

const bytes = (s: string) => new TextEncoder().encode(s);

/** The UTF-8 byte order mark, EF BB BF. */
const BOM = [0xef, 0xbb, 0xbf];

/** U+1F600, a four-byte UTF-8 character (F0 9F 98 80) and a UTF-16 surrogate pair. */
const FOUR_BYTE = "\u{1F600}";

/** U+00A0, the no-break space (C2 A0): whitespace to trimStart, but not to JSON.parse. */
const NO_BREAK_SPACE = "\u00A0";

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

  test("an integer JSON.parse would round keeps every digit sent, as a string (docs/ADDING_A_PROVIDER.md)", () => {
    expect(decodeBytes(bytes('{"id":12345678901234567890,"n":9007199254740993}'), 1000)).toEqual({
      value: { id: "12345678901234567890", n: "9007199254740993" },
      encoding: "json",
      truncated: false,
    });
    expect(decodeBytes(bytes("[12345678901234567890,-12345678901234567890]"), 1000).value).toEqual([
      "12345678901234567890",
      "-12345678901234567890",
    ]);
    // Controls: an integer JSON.parse keeps exactly stays a number, and digits inside a string stay as they are.
    expect(decodeBytes(bytes('{"n":9007199254740991}'), 1000).value).toEqual({ n: 9007199254740991 });
    expect(decodeBytes(bytes('{"s":"12345678901234567890 in a string"}'), 1000).value).toEqual({
      s: "12345678901234567890 in a string",
    });
  });

  test("past the cell limit, a JSON value with such an integer shows its own cut text, not the quoted one", () => {
    expect(decodeBytes(bytes('{"id":12345678901234567890}'), 10)).toEqual({
      value: '{"id":1234',
      encoding: "json",
      truncated: true,
    });
  });

  test("quoting runs only on text JSON.parse accepted: an unquoted integer name is never made JSON", () => {
    expect(decodeBytes(bytes("{12345678901234567890:1}"), 1000)).toEqual({
      value: "{12345678901234567890:1}",
      encoding: "text",
      truncated: false,
    });
  });

  test("a repeated member name is text, since JSON.parse would keep only its last value", () => {
    for (const sent of [
      '{"a":1,"a":2}',
      // The same name written with an escape.
      '{"a":1,"\\u0061":2}',
      // Inside a nested object, and in the outer object after a nested one closed.
      '{"o":{"a":1,"a":2}}',
      '{"a":{"x":1},"a":2}',
    ]) {
      expect(decodeBytes(bytes(sent), 1000)).toEqual({ value: sent, encoding: "text", truncated: false });
    }
    // Controls: one name in two objects, or at two levels, is no repeat, and a string value, in an
    // object or an array, is not a name.
    expect(decodeBytes(bytes('[{"a":1},{"a":2}]'), 1000).value).toEqual([{ a: 1 }, { a: 2 }]);
    expect(decodeBytes(bytes('{"o":{"a":1},"a":2}'), 1000).value).toEqual({ o: { a: 1 }, a: 2 });
    expect(decodeBytes(bytes('{"a":"a","b":["a","b","b"]}'), 1000).value).toEqual({ a: "a", b: ["a", "b", "b"] });
  });

  test("a number whose double is not the number sent is text: overflow, underflow, lost digits and -0", () => {
    for (const sent of [
      "[1e400]",
      '{"f":1.10,"e":1e400,"z":-0}',
      '{"n":1e-400}',
      '{"n":0.1000000000000000055511151231257827}',
      '{"big":12345678901234567890.0}',
      // JSON.stringify writes negative zero as 0.
      '{"z":-0}',
      "[-0.0]",
    ]) {
      expect(decodeBytes(bytes(sent), 1000)).toEqual({ value: sent, encoding: "text", truncated: false });
    }
  });

  test("a number spelled otherwise than JSON.stringify writes it, but of the same value, stays json", () => {
    const sent =
      "[1,2.5,-3,1e2,1E+2,1.10,100.0,0.1,5e-1,0.1e1,12e-1,0.00012,1.2e-4,0,0.0,5e-324,1.7976931348623157e308]";
    expect(decodeBytes(bytes(sent), 1000)).toEqual({
      value: [1, 2.5, -3, 100, 100, 1.1, 100, 0.1, 0.5, 1, 1.2, 0.00012, 0.00012, 0, 0, 5e-324, 1.7976931348623157e308],
      encoding: "json",
      truncated: false,
    });
  });

  test("the scan that finds names and numbers skips a string whole, escaped quotes included", () => {
    // Read without the escape, the quote before 1e400 would close the string and leave a number that overflows.
    expect(decodeBytes(bytes('{"k":"say \\"1e400\\" twice"}'), 1000)).toEqual({
      value: { k: 'say "1e400" twice' },
      encoding: "json",
      truncated: false,
    });
  });

  test("a repeated name or a number that is not the one sent makes a value past the cell limit text too", () => {
    // 27 bytes: past the cell limit of 10, within the prefix bound of 40, so the JSON rule judges it.
    expect(decodeBytes(bytes(`{"a":1,"a":2,"pad":"${"y".repeat(5)}"}`), 10)).toEqual({
      value: '{"a":1,"a"',
      encoding: "text",
      truncated: true,
    });
  });

  test("JSON whitespace before an object or an array does not stop it being JSON, as it does not stop JSON.parse", () => {
    expect(decodeBytes(bytes(' {"a":1}'), 1000)).toEqual({ value: { a: 1 }, encoding: "json", truncated: false });
    expect(decodeBytes(bytes("\n[1]"), 1000)).toEqual({ value: [1], encoding: "json", truncated: false });
    expect(decodeBytes(bytes('\t\r\n {"b":2}'), 1000)).toEqual({ value: { b: 2 }, encoding: "json", truncated: false });
    // Control: a no-break space is whitespace to trimStart but not to JSON.parse, so the value is text.
    expect(decodeBytes(bytes(`${NO_BREAK_SPACE}{"a":1}`), 1000)).toEqual({
      value: `${NO_BREAK_SPACE}{"a":1}`,
      encoding: "text",
      truncated: false,
    });
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

  test("a cell of exactly the limit is whole, and one character more is cut", () => {
    expect(decodeBytes(bytes("x".repeat(10)), 10)).toEqual({
      value: "x".repeat(10),
      encoding: "text",
      truncated: false,
    });
    // [1,2,3,45] is 10 characters.
    expect(decodeBytes(bytes("[1,2,3,45]"), 10)).toEqual({ value: [1, 2, 3, 45], encoding: "json", truncated: false });
    // "schema id 42, not decoded" is 25 characters.
    expect(decodeBytes(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x2a]), 25)).toEqual({
      value: "schema id 42, not decoded",
      encoding: "confluent",
      truncated: false,
    });
    expect(decodeHeaderName(bytes("n".repeat(10)), 10)).toEqual({
      value: "n".repeat(10),
      encoding: "text",
      truncated: false,
    });
    // Controls: one character past the limit.
    expect(decodeBytes(bytes("x".repeat(11)), 10)).toEqual({
      value: "x".repeat(10),
      encoding: "text",
      truncated: true,
    });
    expect(decodeBytes(bytes("[1,2,3,456]"), 10)).toEqual({ value: "[1,2,3,456", encoding: "json", truncated: true });
  });

  test("at the provider's 64 KiB cell limit, a text value and a JSON value of exactly the limit are whole", () => {
    const limit = 64 * 1024;
    expect(decodeBytes(bytes("x".repeat(limit)), limit)).toEqual({
      value: "x".repeat(limit),
      encoding: "text",
      truncated: false,
    });
    // Two brackets and two quotes around limit - 4 characters.
    const inner = "y".repeat(limit - 4);
    expect(decodeBytes(bytes(`["${inner}"]`), limit)).toEqual({ value: [inner], encoding: "json", truncated: false });
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

  test("a cut that falls just after a whole surrogate pair keeps the pair", () => {
    // a, U+1F600, bcd: a cut at 3 ends on U+1F600's second code unit, so the character is kept whole.
    expect(decodeBytes(bytes(`a${FOUR_BYTE}bcd`), 3)).toEqual({
      value: `a${FOUR_BYTE}`,
      encoding: "text",
      truncated: true,
    });
    expect(decodeHeaderName(bytes(`a${FOUR_BYTE}bcd`), 3)).toEqual({
      value: `a${FOUR_BYTE}`,
      encoding: "text",
      truncated: true,
    });
    // [, a quote, U+1F600, xx, a quote and ]: a cut at 4 ends on the pair's second unit too.
    expect(decodeBytes(bytes(`["${FOUR_BYTE}xx"]`), 4)).toEqual({
      value: `["${FOUR_BYTE}`,
      encoding: "json",
      truncated: true,
    });
  });

  test("the back-off covers the whole first-half range, from U+10000 to U+10FFFF", () => {
    // Their first code units are 0xD800 and 0xDBFF, the two ends of the range a pair starts with.
    for (const astral of ["\u{10000}", "\u{10FFFF}"]) {
      expect(decodeBytes(bytes(`a${astral}b`), 2)).toEqual({ value: "a", encoding: "text", truncated: true });
    }
  });

  test("JSON past the cell limit but within the prefix bound keeps its label, and its cut text is shown", () => {
    const json = decodeBytes(bytes(`{"a":"${"y".repeat(30)}"}`), 20);
    expect(json).toMatchObject({ encoding: "json", truncated: true });
    expect(json.value).toBe(`{"a":"${"y".repeat(14)}`);
  });

  test("a value past the prefix bound is judged on its first bytes: never parsed as JSON", () => {
    expect(decodeBytes(bytes(`{"a":"${"y".repeat(60)}"}`), 10)).toMatchObject({ encoding: "text", truncated: true });
  });

  test("the prefix bound is exactly four times the cell limit: JSON one byte past it is judged as text", () => {
    // At a limit of 10 the bound is 40 bytes, and five or six times the limit would lie past both values.
    const at = bytes(`{"a":"${"y".repeat(32)}"}`);
    const past = bytes(`{"a":"${"y".repeat(33)}"}`);
    expect([at.length, past.length]).toEqual([40, 41]);
    expect(decodeBytes(at, 10)).toEqual({ value: '{"a":"yyyy', encoding: "json", truncated: true });
    expect(decodeBytes(past, 10)).toEqual({ value: '{"a":"yyyy', encoding: "text", truncated: true });
  });

  test("rule 4 reads the bound's bytes and no more: an invalid byte just past it is not seen, and one on it is", () => {
    // 41 bytes at a limit of 10: the bound's 40 bytes are valid, the 41st is not.
    expect(decodeBytes(new Uint8Array([...bytes("a".repeat(40)), 0xff]), 10)).toEqual({
      value: "a".repeat(10),
      encoding: "text",
      truncated: true,
    });
    // Control: the invalid byte as the bound's 40th byte is inside what rule 4 checks, so rule 5 answers.
    expect(decodeBytes(new Uint8Array([...bytes("a".repeat(39)), 0xff, 0x61]), 10).encoding).toBe("base64");
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
