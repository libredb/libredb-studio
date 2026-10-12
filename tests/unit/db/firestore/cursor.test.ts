/**
 * The Keys panel cursor envelope (spec 5.3): "0" starts a level, everything else is `fsk1.` and unpadded base64url of
 * a JSON object of at most 1,536 bytes in at most 2,048 characters, checked before any decoding, bound to the pattern
 * it was issued for, and refused with its own sentence for each way it can be wrong.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import {
  decodeLevelCursor,
  encodeLevelCursor,
  FIRESTORE_CURSOR_SENTENCES as C,
  type LevelCursor,
} from "@/lib/db/providers/document/firestore/cursor";

const envelope = (value: unknown): string => `fsk1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
const bytesEnvelope = (bytes: number[]): string => `fsk1.${Buffer.from(bytes).toString("base64url")}`;

function refusal(text: string, pattern = ""): string {
  try {
    decodeLevelCursor(text, pattern);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).provider).toBe(FIRESTORE_TYPE);
    return (error as Error).message;
  }
  throw new Error(`decodeLevelCursor accepted ${text}`);
}

describe("the cursor envelope", () => {
  test("every arm round-trips under its own pattern", () => {
    const cursors: LevelCursor[] = [
      { v: 1, p: "", a: "users/" },
      { v: 1, p: "users/al", a: "users/alice" },
      { v: 1, p: "users/", t: "CgVhbGljZQ" },
      { v: 1, p: "users/", t: "CgVhbGljZQ", o: "users/alice/" },
      { v: 1, p: "users/", o: "users/alice/" },
      { v: 1, p: "c o/d%#?`\u00e9\u{1D11E}/", a: "c o/d%#?`\u00e9\u{1D11E}/s p/" },
    ];
    for (const cursor of cursors) {
      const text = encodeLevelCursor(cursor);
      expect(text.startsWith("fsk1.")).toBe(true);
      expect(text).toMatch(/^fsk1\.[A-Za-z0-9_-]+$/);
      expect(decodeLevelCursor(text, cursor.p)).toEqual(cursor);
    }
  });

  test('"0" starts a level', () => {
    expect(decodeLevelCursor("0", "users/")).toBeNull();
  });

  test("a text that is not an envelope is refused", () => {
    expect(refusal("12")).toBe(C.notEnvelope);
    expect(refusal("fsk2.e30")).toBe(C.notEnvelope);
    expect(refusal("fsk1.")).toBe(C.notEnvelope);
    expect(refusal("fsk1.e30=")).toBe(C.notEnvelope);
    expect(refusal("fsk1.e")).toBe(C.notEnvelope);
    expect(refusal(bytesEnvelope([0xff]))).toBe(C.notEnvelope);
    expect(refusal(envelope([1, 2]))).toBe(C.notEnvelope);
    expect(refusal(envelope("text"))).toBe(C.notEnvelope);
    // `eyJ2IjoxfQ` is {"v":1}; its last character with non-zero unused bits is not the canonical spelling.
    expect(refusal("fsk1.eyJ2IjoxfR")).toBe(C.notEnvelope);
  });

  test("the character bound is checked before decoding", () => {
    // 1,536 bytes of JSON decode within the byte bound, yet spell 2,053 characters.
    const atBytes = { v: 1, p: "x".repeat(1513), a: "y/" };
    expect(JSON.stringify(atBytes)).toHaveLength(1536);
    expect(envelope(atBytes)).toHaveLength(2053);
    expect(refusal(envelope(atBytes), atBytes.p)).toBe(C.notEnvelope);
    const within = { v: 1 as const, p: "x".repeat(1507), a: "y/" };
    expect(envelope(within)).toHaveLength(2045);
    expect(decodeLevelCursor(envelope(within), within.p)).toEqual(within);
    // 1,532 bytes spell exactly 2,048 characters, and one byte more spells 2,049.
    const exact = { v: 1 as const, p: "x".repeat(1509), a: "y/" };
    expect(envelope(exact)).toHaveLength(2048);
    expect(decodeLevelCursor(envelope(exact), exact.p)).toEqual(exact);
    const over = { v: 1, p: "x".repeat(1510), a: "y/" };
    expect(envelope(over)).toHaveLength(2049);
    expect(refusal(envelope(over), over.p)).toBe(C.notEnvelope);
  });

  test("another version is refused", () => {
    expect(refusal(envelope({ v: 2, p: "", a: "users/" }))).toBe(C.version);
    expect(refusal(envelope({ p: "", a: "users/" }))).toBe(C.version);
  });

  test("malformed fields are refused", () => {
    expect(refusal(envelope({ v: 1, p: "", a: "users/", x: 1 }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: 5, a: "users/" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "", a: "" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "", a: "users/", t: "T" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "users/", t: "" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "users/", t: 7 }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "users/", o: "users/alice" }), "users/")).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "", a: "users/", o: "users/x/" }))).toBe(C.malformed);
    expect(refusal(envelope({ v: 1, p: "users/", o: 3 }), "users/")).toBe(C.malformed);
    // A lone surrogate spelled as a JSON escape names no id.
    expect(refusal("fsk1." + Buffer.from('{"v":1,"p":"","a":"\\ud800/"}').toString("base64url"))).toBe(C.malformed);
  });

  test("a cursor issued for another level is refused", () => {
    expect(refusal(encodeLevelCursor({ v: 1, p: "users/", t: "T" }), "orders/")).toBe(C.otherLevel);
    expect(refusal(encodeLevelCursor({ v: 1, p: "", a: "users/" }), "us")).toBe(C.otherLevel);
  });

  test("the sentences", () => {
    expect(C.expired).toBe("This listing expired; list the level again");
    for (const sentence of Object.values(C)) expect(sentence.length).toBeGreaterThan(0);
    expect(Object.isFrozen(C)).toBe(true);
  });

  test("a position too long for the envelope is refused when encoded", () => {
    expect(() => encodeLevelCursor({ v: 1, p: "x".repeat(2000), a: "y/" })).toThrow(QueryError);
    expect(() => encodeLevelCursor({ v: 1, p: "x".repeat(2000), a: "y/" })).toThrow(C.tooLong);
    expect(encodeLevelCursor({ v: 1, p: "x".repeat(1509), a: "y/" })).toHaveLength(2048);
    expect(() => encodeLevelCursor({ v: 1, p: "x".repeat(1510), a: "y/" })).toThrow(C.tooLong);
  });
});
