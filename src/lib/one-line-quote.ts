/**
 * A value quoted for a sentence or a log line, kept on one line and in reading order. It imports nothing, so a module
 * that must reach none of Studio's engine knowledge (the lock command, scripts/providers-lock.ts) quotes with it as
 * `quoteTypeId` in src/lib/db/type-id.ts does.
 */

/**
 * The code points `JSON.stringify` leaves raw that could still break or reorder a line: the C1 controls (U+0080 to
 * U+009F), the line and paragraph separators (U+2028, U+2029) and the twelve bidirectional controls of Unicode's
 * Bidi_Control property (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
 */
const UNESCAPED_LINE_HAZARDS = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `value` quoted for a sentence or a log line. `JSON.stringify` escapes a C0 control character, the quote and the
 * backslash; the code points of `UNESCAPED_LINE_HAZARDS` are escaped as `\uXXXX` too, so the quoted value stays on one
 * line and reads in order. The value is not truncated.
 */
export function quoteOneLine(value: string): string {
  return JSON.stringify(value).replace(
    UNESCAPED_LINE_HAZARDS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
