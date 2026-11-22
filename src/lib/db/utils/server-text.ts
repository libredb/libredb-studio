/**
 * The one boundary a server's own text crosses before Studio puts it into an error, a warning, a log line or an
 * audit row.
 *
 * A provider computes its secret's forms once at connect, with `secretForms`, and passes every server text
 * through `serverText` once, at the entry of its error mapping, before any sentence is built from it. A text that
 * holds any form is replaced whole by one fixed sentence, never masked in part, because a partial mask still
 * shows the secret's length and its neighbours. A hostile endpoint that holds the secret can still return it
 * transformed in a way no list catches, which each provider doc states as a limit.
 *
 * Server only, and it names no engine: each provider passes its own secrets.
 */

import { withoutDroppedControls } from "@/lib/logged-text";

const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

/** A JSON string escape: `\uXXXX` or a backslash before one of `"\/bfnrt`. */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const CONTROL_ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/** How many levels of JSON string escapes a text is read through: JSON nested in JSON adds one level per encoding. */
const MAX_ESCAPE_LEVELS = 8;

/**
 * A value shaped as a JSON Web Token: three base64url segments, the signature segment possibly empty, and the
 * header and claims each a JSON object, whose base64url starts `eyJ` (the encoding of `{"`). Any dotted value,
 * such as a password `my.company.com`, would otherwise add pieces as short as `com`, which nearly every server
 * text holds.
 */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/;

/**
 * The base64 of a secret behind a prefix of `offset` bytes, without the characters the prefix touches: the first 2
 * for a one-byte prefix, the first 3 for a two-byte prefix.
 */
function base64AtOffset(secret: string, offset: 1 | 2): string {
  return Buffer.concat([Buffer.alloc(offset), Buffer.from(secret, "utf8")])
    .toString("base64")
    .replace(/=+$/, "")
    .slice(offset === 1 ? 2 : 3);
}

/**
 * Each non-empty secret, its base64 at each of the three byte offsets, its `encodeURIComponent` form, and each
 * dot-separated segment of a value shaped as a JWT.
 *
 * Every base64 form is written without its `=` padding, so it is found in a padded and an unpadded text alike.
 * Base64 encodes three bytes in four characters, so the base64 of a value that ends with the secret holds one of the
 * three forms whatever the length of what precedes the secret, as in an HTTP Basic header's `user:secret` or an ApiKey
 * header's `id:secret`.
 * An offset form leaves out the characters a preceding byte touches, and those also carry the top bits of the
 * secret's first byte, so it also matches a value whose first character differs from the secret's only in those bits.
 * No form is shorter than the secret itself for a secret of two or more characters.
 */
export function secretForms(secrets: readonly string[]): readonly string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === "") continue;
    forms.add(secret);
    forms.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
    forms.add(base64AtOffset(secret, 1));
    forms.add(base64AtOffset(secret, 2));
    forms.add(encodeURIComponent(secret));
    if (JWT_SHAPE.test(secret)) {
      for (const segment of secret.split(".")) if (segment !== "") forms.add(segment);
    }
  }
  return [...forms];
}

/** A text with one level of JSON string escapes undone. */
function unescapedOnce(text: string): string {
  return text.replace(JSON_ESCAPE, (_match, hex: string | undefined, char: string) =>
    hex === undefined ? (CONTROL_ESCAPES[char] ?? char) : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Every reading of a text the forms are matched against, each computed once and only when the one before it held no
 * form: the text as written first, then the same text without the control characters the logger drops, when it
 * differs; then each level of JSON string escapes undone from that text without those characters, read the same two
 * ways, until nothing changes or `MAX_ESCAPE_LEVELS` levels are undone.
 * Each level is undone from the text without those characters, so a control character between a backslash and the
 * character it escapes, as in a text encoded as UTF-16LE and read one byte per character, does not keep the escape
 * from being undone.
 */
function* readings(raw: string): Generator<string> {
  let current = raw;
  for (let level = 0; ; level++) {
    yield current;
    const logged = withoutDroppedControls(current);
    if (logged !== current) yield logged;
    if (level === MAX_ESCAPE_LEVELS) return;
    const next = unescapedOnce(logged);
    if (next === logged) return;
    current = next;
  }
}

/**
 * Whether any non-empty form occurs in a text, matched case-sensitively, in the text as written or in any of its
 * readings: through JSON string escapes, nested up to `MAX_ESCAPE_LEVELS` levels, and without the control characters
 * the logger drops (`withoutDroppedControls`), so a form written with JSON string escapes, or with such a character
 * between its characters, is found. A tab, a line feed or a carriage return is read as written, as the logger keeps
 * it. The one predicate `serverText` applies, and the one core's scrub of provider text
 * (src/lib/db/operations/provider-text.ts) applies, so the two never match differently.
 */
export function holdsSecretForm(raw: string, forms: readonly string[]): boolean {
  const present = forms.filter((form) => form !== "");
  if (present.length === 0) return false;
  for (const reading of readings(raw)) if (present.some((form) => reading.includes(form))) return true;
  return false;
}

/** The raw text unchanged, or the withheld sentence when any form occurs in it, matched case-sensitively. */
export function serverText(raw: string, forms: readonly string[]): string {
  return holdsSecretForm(raw, forms) ? WITHHELD : raw;
}
