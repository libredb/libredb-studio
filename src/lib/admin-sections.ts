export const ADMIN_SECTIONS = ["overview", "operations", "monitoring", "security", "audit"] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

const DEFAULT_ADMIN_SECTION: AdminSection = "overview";

export function isAdminSection(value: string | null | undefined): value is AdminSection {
  return value != null && (ADMIN_SECTIONS as readonly string[]).includes(value);
}

export function adminSectionPath(section: AdminSection): string {
  return `/admin/${section}`;
}

/** Resolve active admin section from a pathname like `/admin/operations`. */
export function adminSectionFromPathname(pathname: string): AdminSection {
  const segment = pathname.split("/").filter(Boolean)[1];
  return isAdminSection(segment) ? segment : DEFAULT_ADMIN_SECTION;
}

/** Map legacy `?tab=` values (and bare `/admin`) to a section path. */
export function resolveAdminRedirectPath(tab: string | null | undefined): string {
  if (isAdminSection(tab)) {
    return adminSectionPath(tab);
  }
  return adminSectionPath(DEFAULT_ADMIN_SECTION);
}
