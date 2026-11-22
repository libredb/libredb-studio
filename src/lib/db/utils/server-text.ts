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

const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

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

/**
 * Whether any non-empty form occurs in a text, matched case-sensitively. The one predicate `serverText` applies, and
 * the one core's scrub of provider text (src/lib/db/operations/provider-text.ts) applies, so the two never match
 * differently.
 */
export function holdsSecretForm(raw: string, forms: readonly string[]): boolean {
  return forms.some((form) => form !== "" && raw.includes(form));
}

/** The raw text unchanged, or the withheld sentence when any form occurs in it, matched case-sensitively. */
export function serverText(raw: string, forms: readonly string[]): string {
  return holdsSecretForm(raw, forms) ? WITHHELD : raw;
}
