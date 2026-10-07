/**
 * Cypher quoting (spec 3.2, E11).
 *
 * Pure, and shipped to the browser. Every generator writes a label, relationship type or property
 * name through `quoteCypherName` and a literal through `quoteCypherString`, so what the user clicked
 * reaches the server as one token holding exactly that value. A name is always backticked, even
 * when a bare word would do, so a name that happens to be a keyword needs no special case.
 *
 * A name the server could read as something else is refused rather than quoted: a control character,
 * and a unicode escape, which the server decodes before it reads the text (a backslash-u0060 into a
 * backtick that ends the name early, a backslash-u0061 into an `a`). The read policy refuses a
 * statement holding one, so the generator refuses the name by the same pattern, `CYPHER_UNICODE_ESCAPE`,
 * and the two cannot disagree about what a safe name is (#1295).
 */

/** A name that cannot be quoted safely; `name_` is the name refused (`name` is the error's class name). */
export class CypherNameError extends Error {
  readonly name_: string;

  constructor(name: string, reason: string) {
    super(`The name ${JSON.stringify(name)} cannot be written as a Cypher identifier: ${reason}.`);
    this.name = "CypherNameError";
    this.name_ = name;
    Object.setPrototypeOf(this, CypherNameError.prototype);
  }
}

/**
 * A backslash-u at the end of an odd run of backslashes, as the server reads an escape; the group is the
 * escaping backslash and its u. Lower-case only: the server keeps an upper-case `\U` as written. Shared
 * with the read policy, which refuses any statement it matches.
 */
export const CYPHER_UNICODE_ESCAPE = /(?<!\\)(?:\\\\)*(\\u)/;

/** A unicode escape found in a text: its offset, and up to six characters from it. */
export interface CypherUnicodeEscape {
  readonly position: number;
  readonly escape: string;
}

/** The first escape `CYPHER_UNICODE_ESCAPE` finds in `text`, or undefined when it holds none. */
export function cypherUnicodeEscapeIn(text: string): CypherUnicodeEscape | undefined {
  const match = CYPHER_UNICODE_ESCAPE.exec(text);
  if (match === null) return undefined;
  const position = match.index + match[0].length - 2;
  return { position, escape: text.slice(position, position + 6) };
}

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const STRING_ESCAPED = /[\\'\u0000-\u001F]/g;

/**
 * Always backticks; doubles every backtick. Throws `CypherNameError` for an empty name, a character
 * below U+0020 or U+007F, and a unicode escape as `CYPHER_UNICODE_ESCAPE` reads one.
 */
export function quoteCypherName(name: string): string {
  if (name.length === 0) throw new CypherNameError(name, "it is empty");
  if (CONTROL_CHARACTER.test(name)) throw new CypherNameError(name, "it holds a control character");
  const found = cypherUnicodeEscapeIn(name);
  if (found !== undefined) {
    throw new CypherNameError(
      name,
      `it holds the escape ${found.escape}, which the server decodes before it reads the text`,
    );
  }
  return `\`${name.replaceAll("`", "``")}\``;
}

/** Single-quoted string literal with `\` and `'` escaped; characters below U+0020 as `\uXXXX`. */
export function quoteCypherString(value: string): string {
  const escaped = value.replace(STRING_ESCAPED, (character) =>
    character === "\\" || character === "'"
      ? `\\${character}`
      : `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
  return `'${escaped}'`;
}
