/**
 * The S3 preview's gzip layer: a streaming gunzip with Z_SYNC_FLUSH decodes
 * a stored prefix, stops a bomb within one 64 KiB chunk of the cap and slices to exactly the cap, and says the stream
 * ended only when it ended by itself on a whole object.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { gunzipPrefix } from "@/lib/db/providers/objectstore/s3/preview-gzip";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const gzip = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));
const broken = Uint8Array.of(0x1f, 0x8b, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03);
const sample = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${(index * 7919) % 10_007}\n`).join("");

describe("gunzipPrefix", () => {
  test("a prefix of a gzip file decodes to its decodable part, with ended false", async () => {
    const stored = gzip(utf8(sample));
    const result = await gunzipPrefix(stored.subarray(0, Math.floor(stored.length / 2)), 1_000_000, false);
    expect(result.bad).toBe(false);
    if (result.bad) return;
    expect(result.ended).toBe(false);
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(sample.startsWith(text(result.bytes))).toBe(true);
  });

  test("the output is exactly cap bytes long when the cap is hit", async () => {
    const result = await gunzipPrefix(gzip(utf8("a".repeat(200_000))), 1_000, true);
    expect(result).toEqual({ bad: false, bytes: utf8("a".repeat(1_000)), ended: false });
  });

  test("a whole small object gives ended true only when whole is true", async () => {
    const stored = gzip(utf8('{"a":1}'));
    expect(await gunzipPrefix(stored, 1_000, true)).toEqual({ bad: false, bytes: utf8('{"a":1}'), ended: true });
    expect(await gunzipPrefix(stored, 1_000, false)).toEqual({ bad: false, bytes: utf8('{"a":1}'), ended: false });
  });

  test("a 64 MiB zero bomb stops at the cap", async () => {
    const stored = gzip(new Uint8Array(64 * 1_048_576));
    const result = await gunzipPrefix(stored, 1_000_000, true);
    expect(result.bad).toBe(false);
    if (result.bad) return;
    expect(result.bytes.length).toBe(1_000_000);
    expect(result.ended).toBe(false);
  });

  test("bytes that are not gzip are bad", async () => {
    expect(await gunzipPrefix(utf8("id,name\n1,a\n"), 1_000, true)).toEqual({ bad: true });
  });

  test("an error after some output keeps that output, with ended false", async () => {
    const first = gzip(utf8("a".repeat(200_000)));
    const stored = new Uint8Array([...first, ...broken]);
    const result = await gunzipPrefix(stored, 1_000_000, true);
    expect(result.bad).toBe(false);
    if (result.bad) return;
    expect(result.ended).toBe(false);
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBeLessThan(200_000);
    expect(result.bytes.every((byte) => byte === 97)).toBe(true);
  });

  test("a small member followed by a broken header is bad, because the failing call's output is lost", async () => {
    const stored = new Uint8Array([...gzip(utf8("first member")), ...broken]);
    expect(await gunzipPrefix(stored, 1_000, true)).toEqual({ bad: true });
  });

  test("two members decode as one stream", async () => {
    const stored = new Uint8Array([...gzip(utf8("ab")), ...gzip(utf8("cd"))]);
    expect(await gunzipPrefix(stored, 1_000, true)).toEqual({ bad: false, bytes: utf8("abcd"), ended: true });
  });

  test("empty input decodes to nothing and ends", async () => {
    expect(await gunzipPrefix(new Uint8Array(0), 1_000, true)).toEqual({
      bad: false,
      bytes: new Uint8Array(0),
      ended: true,
    });
  });
});
