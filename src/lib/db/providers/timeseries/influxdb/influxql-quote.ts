/**
 * InfluxQL quoting (C6, E6).
 *
 * Pure, and shipped to the browser. Every InfluxQL text Studio writes (tree reads, introspection,
 * completion inserts, Generate Query) builds a name with `quoteInfluxqlIdentifier`, a literal with
 * `quoteInfluxqlString` and a measurement source with `influxqlSource`, so what the user clicked
 * reaches the server as one token holding exactly that value. A name is always double-quoted, even
 * when a bare word would do, so a name that happens to be a keyword needs no special case.
 *
 * The influxql scanner knows exactly four escapes inside a quoted token: `\n`, `\\`, `\"` and `\'`
 * (DECISIONS I8 C1). A backslash and the token's own quote are escaped; a newline is written as the
 * two characters `\n`, because the scanner ends a quoted token at a raw newline and reads `\n` back
 * as one. Every other C0 control (a tab and a carriage return included) and DEL has no escape in the
 * scanner, and Studio's policy (C2) refuses raw control characters, so a value holding one is refused:
 * a quoted value Studio writes never carries a raw control character. The contract refuses a tab too,
 * although the scanner would read one back unchanged.
 * Non-ASCII characters are data inside quotes and pass unchanged.
 */

/** A value holding a control character the scanner has no escape for; the message names the character class, never the value. */
export class InfluxqlQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfluxqlQuoteError";
    Object.setPrototypeOf(this, InfluxqlQuoteError.prototype);
  }
}

const UNESCAPABLE_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const IDENTIFIER_ESCAPED = /[\\"\n]/g;
const STRING_ESCAPED = /[\\'\n]/g;

function escapeQuoted(value: string, escaped: RegExp, what: string): string {
  if (UNESCAPABLE_CONTROL.test(value)) {
    throw new InfluxqlQuoteError(
      `An InfluxQL ${what} cannot hold a control character other than a newline (U+0000 to U+001F, or U+007F), because the InfluxQL scanner has no escape for it.`,
    );
  }
  return value.replace(escaped, (character) => (character === "\n" ? "\\n" : `\\${character}`));
}

/** Always double-quoted; `\` becomes `\\`, `"` becomes `\"`, a newline becomes `\n`. Throws on another C0 control or DEL. */
export function quoteInfluxqlIdentifier(name: string): string {
  return `"${escapeQuoted(name, IDENTIFIER_ESCAPED, "name")}"`;
}

/** Single-quoted; `\` becomes `\\`, `'` becomes `\'`, a newline becomes `\n`. Throws on another C0 control or DEL. */
export function quoteInfluxqlString(value: string): string {
  return `'${escapeQuoted(value, STRING_ESCAPED, "string")}'`;
}

/**
 * `"db".."m"`: the database's default retention policy (S1-measured on 1.13.1, 2.9.1 and 3.12.0,
 * SPEC 5.8), so a tree-opened tab always names its database in the text.
 */
export function influxqlSource(database: string, measurement: string): string {
  return `${quoteInfluxqlIdentifier(database)}..${quoteInfluxqlIdentifier(measurement)}`;
}
