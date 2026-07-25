import { describe, expect, test } from "bun:test";
import {
  ADMIN_SECTIONS,
  adminSectionFromPathname,
  adminSectionPath,
  isAdminSection,
  resolveAdminRedirectPath,
} from "@/lib/admin-sections";

describe("admin-sections", () => {
  test("lists five canonical sections", () => {
    expect([...ADMIN_SECTIONS]).toEqual(["overview", "operations", "monitoring", "security", "audit"]);
  });

  test("isAdminSection validates known ids", () => {
    expect(isAdminSection("operations")).toBe(true);
    expect(isAdminSection("nope")).toBe(false);
    expect(isAdminSection(null)).toBe(false);
  });

  test("adminSectionPath builds nested routes", () => {
    expect(adminSectionPath("security")).toBe("/admin/security");
  });

  test("adminSectionFromPathname reads the section segment", () => {
    expect(adminSectionFromPathname("/admin/audit")).toBe("audit");
    expect(adminSectionFromPathname("/admin")).toBe("overview");
    expect(adminSectionFromPathname("/admin/unknown")).toBe("overview");
  });

  test("resolveAdminRedirectPath maps legacy tabs", () => {
    expect(resolveAdminRedirectPath("monitoring")).toBe("/admin/monitoring");
    expect(resolveAdminRedirectPath(undefined)).toBe("/admin/overview");
    expect(resolveAdminRedirectPath("x")).toBe("/admin/overview");
  });
});
