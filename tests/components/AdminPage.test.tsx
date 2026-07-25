import "../setup-dom";
import "../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockRedirect, resetMockPathname } from "../helpers/mock-navigation";

const { default: AdminIndexPage } = await import("@/app/admin/page");

describe("AdminIndexPage", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
  });

  afterEach(() => {
    resetMockPathname();
  });

  test("redirects bare /admin to /admin/overview", async () => {
    await expect(AdminIndexPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT:/admin/overview",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/admin/overview");
  });

  test("redirects legacy ?tab=operations to /admin/operations", async () => {
    await expect(AdminIndexPage({ searchParams: Promise.resolve({ tab: "operations" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/admin/operations",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/admin/operations");
  });

  test("unknown tab falls back to overview", async () => {
    await expect(AdminIndexPage({ searchParams: Promise.resolve({ tab: "nope" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/admin/overview",
    );
  });
});
