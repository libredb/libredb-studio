/**
 * Cypher quoting (spec 3.2, E11).
 *
 * Pure, and shipped to the browser. Every generator writes a label, relationship type or property
 * name through `quoteCypherName` and a literal through `quoteCypherString`, so what the user clicked
 * reaches the server as one token holding exactly that value. A name is always backticked, even
 * when a bare word would do, so a name that happens to be a keyword needs no special case.
 *
 * A name the server could read as something else is refused rather than quoted: a control character,
 * and a backslash-u0060 escape sequence, which the server may decode into a backtick inside the
 * identifier and so end it early.
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

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const BACKTICK_ESCAPE = /\\u0060/i;
const STRING_ESCAPED = /[\\'\u0000-\u001F]/g;

/**
 * Always backticks; doubles every backtick. Throws `CypherNameError` for an empty name, a character
 * below U+0020 or U+007F, and the escape sequence backslash-u0060 in any case.
 */
export function quoteCypherName(name: string): string {
  if (name.length === 0) throw new CypherNameError(name, "it is empty");
  if (CONTROL_CHARACTER.test(name)) throw new CypherNameError(name, "it holds a control character");
  if (BACKTICK_ESCAPE.test(name)) {
    throw new CypherNameError(name, "it holds the escape sequence \\u0060, which the server may read as a backtick");
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
