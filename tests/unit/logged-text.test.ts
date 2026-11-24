/**
 * The control characters the logger drops from every value it writes, in the one function the logger and the
 * credential scrub both read a text through.
 */
import { describe, expect, test } from "bun:test";
import { withoutDroppedControls } from "@/lib/logged-text";

describe("withoutDroppedControls", () => {
  test("removes exactly the C0 controls except tab, line feed and carriage return", () => {
    for (let code = 0; code <= 0x9f; code++) {
      const char = String.fromCharCode(code);
      const dropped = code <= 0x1f && char !== "\t" && char !== "\n" && char !== "\r";
      expect([code, withoutDroppedControls(`a${char}b`)]).toEqual([code, dropped ? "ab" : `a${char}b`]);
    }
  });

  test("removes every occurrence and keeps the rest of the text in order", () => {
    expect(withoutDroppedControls("\u0000a\u0001\u0001b\tc\u001f")).toBe("ab\tc");
  });
});
