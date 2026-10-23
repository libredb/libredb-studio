/**
 * How Studio names the person an identity provider's token stands for, in an import-free module, because the OIDC
 * callback, the governed sign-in rule (src/lib/local-accounts.ts) and the bearer verifier the proxy loads
 * (src/lib/oidc-bearer.ts) need the same answers, and the proxy must not reach the governance state the second imports.
 */

/**
 * An issuer as Studio compares it: serialized by the URL parser, so the host's case and a default port read the same,
 * with one trailing slash dropped, because a bare-host issuer such as Auth0's ends in a slash that `OIDC_ISSUER` may
 * leave out. Null when the value is not a URL.
 */
export function comparableIssuer(value: string): string | null {
  const href = URL.parse(value)?.href;
  if (href === undefined) return null;
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Whether the provider marks the email unverified: `false`, or the string "false" some providers send instead of a
 * boolean. A provider that sends no `email_verified` at all, such as Microsoft Entra ID, marks nothing, and its email
 * is taken as it was before this rule.
 */
function emailMarkedUnverified(value: unknown): boolean {
  return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

/**
 * The session's `username` from a token's claims, or null when no claim can carry it. Without governance `username`
 * keys the person's saved work, rate limit and audit lines, so it comes only from a claim another person cannot copy:
 * the `email`, unless the provider marks it unverified (`email_verified: false`), else a `preferred_username` that is
 * not email-shaped, because a provider may let a user choose that one freely, and `bob@example.com` chosen as a
 * username would otherwise open Bob's workspace.
 */
export function oidcUsername(claims: Record<string, unknown>): string | null {
  const email = nonEmptyString(claims.email);
  if (email !== null && !emailMarkedUnverified(claims.email_verified)) return email;
  const name = nonEmptyString(claims.preferred_username);
  return name !== null && !name.includes("@") ? name : null;
}
