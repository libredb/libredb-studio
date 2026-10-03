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
 * Each non-empty secret, its base64, its `encodeURIComponent` form, and each dot-separated segment of a value
 * shaped as a JWT.
 *
 * The base64 form is written without its `=` padding, so it is found in a padded and an unpadded text alike.
 */
export function secretForms(secrets: readonly string[]): readonly string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === "") continue;
    forms.add(secret);
    forms.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
    forms.add(encodeURIComponent(secret));
    if (JWT_SHAPE.test(secret)) {
      for (const segment of secret.split(".")) if (segment !== "") forms.add(segment);
    }
  }
  return [...forms];
}

/** The raw text unchanged, or the withheld sentence when any form occurs in it, matched case-sensitively. */
export function serverText(raw: string, forms: readonly string[]): string {
  return forms.some((form) => form !== "" && raw.includes(form)) ? WITHHELD : raw;
}
