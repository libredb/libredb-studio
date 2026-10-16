/**
 * The assertions these tests use, in one place.
 *
 * They exist because the modules under test were written and run standalone first, with
 * `node:assert`, and the house runner is `bun:test`. Rather than rewrite 63 assertions by hand and
 * risk changing what one of them means, each `assert` call keeps its shape and is expressed here in
 * terms of `expect`. Every helper is one line, so the translation is readable rather than trusted.
 */
import { expect } from "bun:test";

/** The third argument is the message `node:assert` took, kept so no assertion loses its note. */
export const expectBe = (actual: unknown, expected: unknown, note?: string): void =>
  void expect(actual, note).toBe(expected as never);
export const expectNotBe = (actual: unknown, expected: unknown): void =>
  void expect(actual).not.toBe(expected as never);
export const expectEqual = (actual: unknown, expected: unknown): void => void expect(actual).toEqual(expected as never);
export const expectNotEqual = (actual: unknown, expected: unknown): void =>
  void expect(actual).not.toEqual(expected as never);
export const expectMatch = (actual: string, pattern: RegExp): void => void expect(actual).toMatch(pattern);
/**
 * An assertion function, not a plain call: `node:assert`'s `ok` narrows the type of what it is
 * given, and a test that read a field after it would stop compiling without the narrowing. The
 * house typecheck found exactly that, in six places, which is why this signature is written out.
 */
export function expectTruthy(actual: unknown, note?: string): asserts actual {
  expect(actual, note).toBeTruthy();
}
export const expectThrows = (fn: () => unknown, like?: unknown): void =>
  void (like === undefined ? expect(fn).toThrow() : expect(fn).toThrow(like as never));
export const expectRejects = async (promise: Promise<unknown>, like?: unknown): Promise<void> => {
  if (like === undefined) await expect(promise).rejects.toThrow();
  else await expect(promise).rejects.toThrow(like as never);
};

/**
 * Source with COMMENTS removed, and nothing else, for the bands that scan text.
 *
 * It is shared because two bands need it and a second copy would drift: one asks that no file
 * performs an outward write, the other that a requirement-bound export is called from somewhere.
 * Both are about CALLS, and both would otherwise read their own explanations as code.
 *
 * Strings are NOT removed, and that is the measured conclusion of three attempts rather than a
 * shortcut.
 *
 * Attempt one removed comments only in one band and nothing in the other, so a name mentioned in a
 * comment counted as a caller: the band passed on an export with no caller at all, which is the
 * one thing it exists to find.
 *
 * Attempt two blanked template literals as well, and the band then reported `escapeXml` as
 * uncalled, because every one of its calls sits inside a template literal in `requests.ts`.
 *
 * Attempt three skipped literals containing `${`, which made the pattern match from the END of one
 * literal to the START of the next and swallow everything between, hiding the call to
 * `messageIdOf`. Blanking double-quoted strings did the same thing for a larger span: a `"` inside
 * a REGEX literal pairs with a quote far away, and `session.ts` lost more than half its text,
 * 9,308 characters down to 4,222.
 *
 * So the rule is comments only. The cost is that a name written as text inside a string counts as
 * a mention, which can make a band raise a finding that is not one, or miss one that is. The three
 * attempts above all DELETED REAL CODE, and a scan that deletes what it is counting reports clean.
 * Between a loud wrong answer and a quiet one, this takes the loud one.
 */
export function strippedSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
