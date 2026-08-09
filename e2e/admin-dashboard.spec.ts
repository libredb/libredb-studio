import { test, expect } from "@playwright/test";

test.describe("Admin Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: /sign in/i }).click();
    // /admin redirects to /admin/overview
    await page.waitForURL("**/admin/**");
  });

  test("admin dashboard loads", async ({ page }) => {
    // Scoped to the heading role, not a bare text locator: Next 16.3.0 shifted the timing of
    // the App Router's accessibility route-announcer (the hidden shadow-DOM live region Next
    // renders for screen readers on client navigation) relative to 16.1.6, so the announcer's
    // text now settles to this page's title ("Admin Dashboard", the h1 fallback - this app sets
    // no per-route <title>) within the assertion's polling window. A bare `text=Admin Dashboard`
    // locator then resolves to two elements - the visible h1 and the announcer - and fails with
    // a strict-mode violation instead of asserting the intended, visible heading.
    await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible({ timeout: 10000 });
  });

  test("shows 5 section nav links", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Admin sections" });
    await expect(nav.getByRole("link", { name: /Overview/i })).toBeVisible({ timeout: 10000 });
    await expect(nav.getByRole("link", { name: /Operations/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Monitoring/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Security/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Audit/i })).toBeVisible();
  });

  test("default section is overview", async ({ page }) => {
    // Overview content is mounted by default — assert on the content region, not
    // empty-state copy, so the test holds whether or not seed connections exist.
    await expect(page.getByTestId("admin-content-overview")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/admin\/overview/);
    const overviewLink = page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", {
      name: /Overview/i,
    });
    await expect(overviewLink).toHaveAttribute("aria-current", "page");
  });

  test("can navigate to operations section", async ({ page }) => {
    await page
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: /Operations/i })
      .click();
    await expect(page).toHaveURL(/\/admin\/operations/);
    // Operations content region mounts regardless of connection state (empty
    // state or populated dashboard), so this is stable across environments.
    await expect(page.getByTestId("admin-content-operations")).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: /Operations/i }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("can navigate to security section", async ({ page }) => {
    await page
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: /Security/i })
      .click();
    await expect(page).toHaveURL(/\/admin\/security/);
    // Security section should show Data Masking content
    await expect(page.locator("text=Data Masking").first()).toBeVisible({ timeout: 5000 });
  });

  test("can navigate to audit section", async ({ page }) => {
    await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: /Audit/i }).click();
    await expect(page).toHaveURL(/\/admin\/audit/);
    // Audit section should show operations/queries headings
    await expect(page.getByTestId("admin-content-audit")).toBeVisible({ timeout: 5000 });
  });

  test("editor button navigates to studio", async ({ page }) => {
    const editorBtn = page.locator('button:has-text("Editor"), a:has-text("Editor")').first();
    await editorBtn.click();
    await page.waitForURL("/");
    await expect(page).toHaveURL("/");
  });

  test("logout button redirects to login", async ({ page }) => {
    const logoutBtn = page.locator('button:has-text("Logout")').first();
    await logoutBtn.click();
    await page.waitForURL("**/login**");
    await expect(page).toHaveURL(/\/login/);
  });
});
