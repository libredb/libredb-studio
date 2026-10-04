/** The console text's size in UTF-8 bytes (vector-family spec 3.4), counted without encoding it. */
import { describe, expect, test } from "bun:test";
import { exceedsUtf8Bytes, utf8ByteLength } from "@/lib/db/console/bounds";

const encoded = (text: string) => new TextEncoder().encode(text).length;

describe("utf8ByteLength", () => {
  test.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["€", 3],
    ["\u{1F600}", 4],
    ["aé€\u{1F600}", 10],
    ["\ud800", 3],
    ["\udc00x", 4],
    ["\ud800\ud800", 6],
  ])("%j is %d bytes, as an encoder writes it", (text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
    expect(utf8ByteLength(text)).toBe(encoded(text));
  });
});

describe("exceedsUtf8Bytes", () => {
  test("a text longer than the limit in code units is over without counting", () => {
    expect(exceedsUtf8Bytes("abcd", 3)).toBe(true);
  });

  test("a text of at most a third of the limit in code units is under without counting", () => {
    expect(exceedsUtf8Bytes("€€", 6)).toBe(false);
  });

  test("a text in between is counted: an emoji at exactly the bound passes and one byte more refuses", () => {
    expect(exceedsUtf8Bytes("\u{1F600}", 4)).toBe(false);
    expect(exceedsUtf8Bytes("a\u{1F600}", 4)).toBe(true);
    expect(exceedsUtf8Bytes("éé", 3)).toBe(true);
    expect(exceedsUtf8Bytes("éé", 4)).toBe(false);
  });
});
