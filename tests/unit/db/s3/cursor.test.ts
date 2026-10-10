/**
 * The Keys panel cursor: a versioned, scope-bound envelope with
 * no MAC and no per-process state, so any provider instance of the connection decodes what another wrote. The text
 * is bounded before any base64 work, the payload at both ends, and a token at the server's own bound.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  cursorInScope,
  decodeS3Cursor,
  encodeS3Cursor,
  S3_CURSOR_SENTENCES,
  type S3Cursor,
} from "@/lib/db/providers/objectstore/s3/cursor";
import { S3_ERROR_SENTENCES } from "@/lib/db/providers/objectstore/s3/errors";

const spelled = (payload: unknown): string =>
  `s3c:1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;

afterEach(() => {
  (Buffer.from as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("encode and decode", () => {
  test.each<[string, S3Cursor]>([
    ["a level page's token", { bucket: "sales", prefix: "2026/", level: true, token: "tok/=+ü" }],
    ["a plain walk's token", { bucket: "sales", prefix: "", level: false, token: "t" }],
    ["the root level's last bucket", { bucket: null, prefix: "sa", level: true, after: "sales" }],
  ])("%s round-trips", (_name, cursor) => {
    const text = encodeS3Cursor(cursor);
    expect(text.startsWith("s3c:1:")).toBe(true);
    expect(decodeS3Cursor(text)).toEqual(cursor);
  });

  test('"0" starts a walk', () => {
    expect(decodeS3Cursor("0")).toBe("start");
  });

  test("the spelling is the documented one", () => {
    expect(encodeS3Cursor({ bucket: "b", prefix: "p/", level: true, token: "t" })).toBe(
      spelled({ b: "b", p: "p/", l: 1, t: "t" }),
    );
  });

  test("a decode depends on nothing but the text, so two decoders agree", () => {
    const text = encodeS3Cursor({ bucket: "sales", prefix: "x/", level: true, token: "abc" });
    expect(decodeS3Cursor(text)).toEqual(decodeS3Cursor(text) as S3Cursor);
  });
});

describe("texts the Keys panel did not write", () => {
  test.each([
    ["another version", `s3c:2:${spelled({ b: "b", p: "", l: 1, t: "t" }).slice(6)}`],
    ["no spelling", "cursor"],
    ["an empty body", "s3c:1:"],
    ["characters outside base64url", "s3c:1:ab+/"],
    ["padding", `${spelled({ b: "b", p: "", l: 1, t: "t" })}=`],
    ["a non-canonical base64url", "s3c:1:AB"],
    ["bytes that are not UTF-8", `s3c:1:${Buffer.from([0xff, 0xfe]).toString("base64url")}`],
    ["text that is not JSON", `s3c:1:${Buffer.from("not json").toString("base64url")}`],
    ["an array", spelled([1])],
    ["a missing prefix", spelled({ b: "b", l: 1, t: "t" })],
    ["a level of 2", spelled({ b: "b", p: "", l: 2, t: "t" })],
    ["a bucket that is a number", spelled({ b: 1, p: "", l: 1, t: "t" })],
    ["an unknown field", spelled({ b: "b", p: "", l: 1, t: "t", x: 1 })],
    ["both a token and an after", spelled({ b: "b", p: "", l: 1, t: "t", a: "x" })],
    ["neither a token nor an after", spelled({ b: "b", p: "", l: 1 })],
    ["a token that is not text", spelled({ b: "b", p: "", l: 1, t: 5 })],
    ["an after that is not text", spelled({ b: null, p: "", l: 1, a: 5 })],
    ["a token over 4,096 characters", spelled({ b: "b", p: "", l: 1, t: "t".repeat(4_097) })],
  ])("%s is undefined", (_name, text) => {
    expect(decodeS3Cursor(text)).toBeUndefined();
  });

  test("a payload over 12,288 bytes is refused by the text bound", () => {
    expect(decodeS3Cursor(spelled({ b: "b", p: "p".repeat(12_300), l: 1, t: "t" }))).toBeUndefined();
  });

  test("a text over 16,390 characters is refused before any base64 call", () => {
    const from = spyOn(Buffer, "from");
    expect(decodeS3Cursor(`s3c:1:${"A".repeat(16_385)}`)).toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("bounds at encode", () => {
  test("a token over 4,096 characters is E22's token sentence", () => {
    expect(() => encodeS3Cursor({ bucket: "b", prefix: "", level: true, token: "t".repeat(4_097) })).toThrow(
      S3_ERROR_SENTENCES.tokenTooLong,
    );
  });

  test("a 1,024-byte prefix of control characters with a 4,096-character token encodes and decodes", () => {
    const cursor: S3Cursor = {
      bucket: "b".repeat(63),
      prefix: "\u0001".repeat(1_024),
      level: true,
      token: "A".repeat(4_096),
    };
    expect(decodeS3Cursor(encodeS3Cursor(cursor))).toEqual(cursor);
  });

  test("a payload over 12,288 bytes is refused at encode with E22's cursor sentence", () => {
    let caught: unknown;
    try {
      encodeS3Cursor({ bucket: "b", prefix: "\u0001".repeat(1_024), level: true, token: "\u0001".repeat(4_096) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as Error).message).toBe(S3_ERROR_SENTENCES.cursorTooLong);
  });
});

describe("scope", () => {
  const cursor: S3Cursor = { bucket: "sales", prefix: "2026/", level: true, token: "t" };

  test("the same bucket, prefix and level is in scope", () => {
    expect(cursorInScope(cursor, { bucket: "sales", prefix: "2026/", level: true })).toBe(true);
    expect(
      cursorInScope({ bucket: null, prefix: "", level: true, after: "a" }, { bucket: null, prefix: "", level: true }),
    ).toBe(true);
  });

  test("another bucket, prefix or level is not; nor is a token at the root or an after inside a bucket", () => {
    expect(cursorInScope(cursor, { bucket: "other", prefix: "2026/", level: true })).toBe(false);
    expect(cursorInScope(cursor, { bucket: "sales", prefix: "2025/", level: true })).toBe(false);
    expect(cursorInScope(cursor, { bucket: "sales", prefix: "2026/", level: false })).toBe(false);
    expect(
      cursorInScope({ bucket: null, prefix: "", level: true, token: "t" }, { bucket: null, prefix: "", level: true }),
    ).toBe(false);
    expect(
      cursorInScope(
        { bucket: "sales", prefix: "", level: true, after: "x" },
        { bucket: "sales", prefix: "", level: true },
      ),
    ).toBe(false);
  });

  test("the two refusals, verbatim", () => {
    expect(S3_CURSOR_SENTENCES).toEqual({
      foreign: "This page's cursor is not one the Keys panel wrote: start the walk again.",
      scope: "This cursor belongs to another bucket, prefix or level: start the walk again.",
    });
  });
});
