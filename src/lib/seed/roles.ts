const RESERVED_ROLES = new Set(["*", "admin", "user"]);

/**
 * Returns the roles usable for seed connection matching for a given principal.
 * Combines [principal.role, ...filteredClaimRoles].
 *
 * If OIDC_ROLE_PREFIX is unset or empty at call time, it returns [principal.role].
 * Each claim role returned MUST:
 * - be a string
 * - start with the current OIDC_ROLE_PREFIX (case-sensitive)
 * - not be in ["*", "admin", "user"] (case-insensitive)
 * - have UTF-8 byte length <= 64
 *
 * Any element in claimRoles failing any of those checks is silently dropped.
 */
export function seedRolesOf(principal: { role: string; claimRoles?: readonly string[] | unknown }): string[] {
  const base = [principal.role];
  const prefix = process.env.OIDC_ROLE_PREFIX;
  if (!prefix) {
    return base;
  }

  const claimRoles = principal.claimRoles;
  if (!Array.isArray(claimRoles)) {
    return base;
  }

  const seen = new Set<string>(base);
  const out: string[] = [];
  for (const r of claimRoles) {
    if (typeof r !== "string") continue;
    if (r.length === 0 || Buffer.byteLength(r, "utf8") > 64) continue;
    if (!r.startsWith(prefix)) continue;
    if (RESERVED_ROLES.has(r.toLowerCase())) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }

  return [...base, ...out];
}
