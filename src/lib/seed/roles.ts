const RESERVED_ROLES = new Set(["*", "admin", "user"]);

/**
 * The role a Kubernetes-discovered connection carries while the access review is on. It starts with NUL, so the seed
 * schema refuses it (control character), no environment variable can hold it (so no OIDC_ROLE_PREFIX admits a claim
 * role equal to it), Studio never mints it as a session role, and rolesMatch refuses any connection carrying it
 * whatever the caller's roles: the gate is the only way such a connection is listed or opened.
 */
export const KUBERNETES_REVIEWED_ROLE = "\u0000libredb:kubernetes-access-review";

/** A C0 or C1 control character or DEL: the class CONTROL_CHAR_REGEX in types.ts refuses in a seed role name. */
const CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Returns the roles usable for seed connection matching for a given principal.
 * Combines [principal.role, ...filteredClaimRoles].
 *
 * If OIDC_ROLE_PREFIX is unset or empty at call time, it returns [principal.role].
 * Each claim role returned MUST:
 * - be a string
 * - hold no C0 or C1 control character and no DEL, the class the seed schema refuses in a role name, checked before
 *   the prefix, so no claim role can equal KUBERNETES_REVIEWED_ROLE whatever the prefix
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
    if (CONTROL_CHARACTER.test(r)) continue;
    if (!r.startsWith(prefix)) continue;
    if (RESERVED_ROLES.has(r.toLowerCase())) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }

  return [...base, ...out];
}
