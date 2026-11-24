/**
 * A text as the logger writes it with respect to control characters.
 *
 * The logger drops these characters from every value it writes, so a log line cannot be forged with them; the
 * credential scrub of server text reads a text through the same function, so it sees a text as the logger would write
 * it. One home for the set, so the two never differ. It imports nothing, so any module can read it.
 */

/** The control characters the logger drops from every value it writes: C0 except tab, line feed and carriage return. */
const DROPPED_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** The text with every control character the logger drops removed, and every other character kept in order. */
export function withoutDroppedControls(value: string): string {
  return value.replace(DROPPED_CONTROLS, "");
}
