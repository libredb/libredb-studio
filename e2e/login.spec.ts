import { test, expect } from "@playwright/test";
import { listShowcaseDatabases } from "../src/lib/db-showcase";
import { LIVE_CHANNELS, LIVE_PLATFORMS } from "../src/lib/distribution/channels.generated";
import { DEPLOY_GROUP_LABELS, DEPLOY_GROUP_ORDER } from "../src/lib/distribution/deploy-groups";
import { WIRE_COMPATIBLE_ENGINES } from "../src/lib/db/compatibility";

test.describe("Login Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("shows login page with email and password fields", async ({ page }) => {
    await expect(page.locator("text=LibreDB Studio").first()).toBeVisible();
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button:has-text("Sign In")').first()).toBeVisible();
  });

  test("admin login redirects to /admin", async ({ page }) => {
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/admin**");
    await expect(page).toHaveURL(/\/admin/);
  });

  test("user login redirects to /", async ({ page }) => {
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/");
    await expect(page).toHaveURL("/");
  });

  test("wrong password shows error", async ({ page }) => {
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    // Should stay on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test("empty fields shows validation error", async ({ page }) => {
    await page.getByRole("button", { name: /sign in/i }).click();
    // Should stay on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test("authenticated admin accessing /login redirects to /admin", async ({ page }) => {
    // Login as admin first
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/admin**");

    // Try navigating back to /login
    await page.goto("/login");
    await expect(page).toHaveURL(/\/admin/);
  });

  test("authenticated user accessing /login redirects to /", async ({ page }) => {
    // Login as user first
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/");

    // Try navigating back to /login
    await page.goto("/login");
    await expect(page).toHaveURL("/");
  });

  test("unauthenticated user accessing / redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("user role cannot access /admin", async ({ page }) => {
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/");

    // Try accessing admin page
    await page.goto("/admin");
    // Should redirect away from admin
    await expect(page).not.toHaveURL(/\/admin/);
  });
});

/**
 * The login hero's showcase blocks (issue #425).
 *
 * Every expectation below is derived from the same modules the page renders from -
 * `listShowcaseDatabases()` over `DB_UI_CONFIG` and the generated live-channel list - never
 * from a number or an engine name typed here. That is the whole point of the change these
 * tests guard: the previous copy hard-coded five engine names and one deploy channel, and
 * nothing failed when the product grew past them. A test that hard-coded the new answers
 * would rot the same way, so it asserts the derivation instead.
 *
 * Both modules are pure data with no server or DOM dependency, which is why the spec can
 * import them directly.
 */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("Login showcase", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("hero lists every configured engine, by its accessible name", async ({ page }) => {
    // Addressed the way a screen reader addresses it: the list's accessible name comes
    // from the "Supported Databases" heading beside it, so this fails if the label is
    // dropped or the association broken, not merely if the markup moves.
    const engines = page.getByTestId("database-showcase-desktop");
    await expect(page.getByRole("list", { name: "Supported Databases" })).toHaveCount(1);
    await expect(engines).toBeVisible();

    // Matched per item as a pattern rather than a string, because the embedded provider's
    // item carries an "(embedded)" marker after its label: the hero claims the external
    // engines only, and this is the marker that tells a reader which pill the claim leaves
    // out. The `embedded` flag comes from the same module the page renders from, so the
    // expectation still names no engine.
    const expected = listShowcaseDatabases();
    await expect(engines.getByRole("listitem")).toHaveCount(expected.length);
    await expect(engines.getByRole("listitem")).toHaveText(
      expected.map((db) => new RegExp(`^${db.label}\\s*${db.embedded ? "\\(embedded\\)" : ""}$`)),
    );
  });

  test("hero names every wire-compatible relative, with the registry's own count", async ({ page }) => {
    // The gap this closes: the hero named the shipped drivers and stopped, while the product
    // connects to forty named products. The twenty-six relatives were published in
    // README.md and the docs compatibility table but on no surface a visitor sees first.
    const line = page.getByTestId("wire-compatible-desktop");
    await expect(line).toBeVisible();
    await expect(line).toContainText(`${WIRE_COMPATIBLE_ENGINES.length}`);
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      await expect(line).toContainText(engine.name);
    }
    // No tier word: the per-engine tier belongs to the connection dialog's hint, which has
    // room to qualify it. A hero line that implied parity would be the overclaim #424 bans.
    await expect(line).not.toContainText(/partial|query-only/i);
  });

  test("hero states the live channel count and names every group", async ({ page }) => {
    // The hero claims the deploy story as a derived number plus the group names; it prints
    // no channel names at all. So the assertion is the count and the four labels, which is
    // what can go stale, rather than a row-per-channel walk of ink that is no longer there.
    const proof = page.getByTestId("hero-proof");
    await expect(proof).toBeVisible();
    await expect(proof).toContainText(`${LIVE_CHANNELS.length}`);

    const groups = new Set(LIVE_CHANNELS.map((channel) => channel.group));
    expect(groups.size).toBeGreaterThan(0);
    for (const group of DEPLOY_GROUP_ORDER) {
      await expect(proof).toContainText(DEPLOY_GROUP_LABELS[group]);
    }

    // The platform line answers the question the count cannot - whether the machine in
    // front of the reader can run it - and it too is filtered from the generated inventory.
    const platformLine = page.getByTestId("platform-line");
    await expect(platformLine).toBeVisible();
    for (const platform of LIVE_PLATFORMS.filter((p) => ["linux", "macos", "windows"].includes(p))) {
      await expect(platformLine).toContainText(new RegExp(platform, "i"));
    }
  });

  test("hero cycles a connection string the parser would accept", async ({ page }) => {
    // The signature is the evidence behind the engine count, so the scheme it opens on must
    // be one the product honours. Rendered client-side in an effect, hence the visibility
    // wait before reading it.
    const signature = page.getByTestId("connection-signature");
    await expect(signature).toBeVisible();
    await expect(signature).toContainText("://");
  });

  test("condensed showcase replaces the hero at a small viewport", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);

    // The two surfaces are one component rendered twice, so the mobile block must carry the
    // same engine set - a count that drifts between them means one variant stopped deriving.
    const mobileEngines = page.getByTestId("database-showcase-mobile");
    await expect(mobileEngines).toBeVisible();
    await expect(mobileEngines.getByRole("listitem")).toHaveCount(listShowcaseDatabases().length);

    // The relatives line is the second half of that engine set, so it must survive the
    // collapse too - a mobile visitor is the one most likely to be evaluating on a phone.
    const mobileRelatives = page.getByTestId("wire-compatible-mobile");
    await expect(mobileRelatives).toBeVisible();
    await expect(mobileRelatives).toContainText(`${WIRE_COMPATIBLE_ENGINES.length}`);

    // The condensed line restates the same claims on one row. Both surfaces mark their
    // agent claim with the same test id, so it is selected by the text only the mobile one
    // carries - the channel count, which is a `.length` and never a written number.
    const mobileClaim = page.getByTestId("agent-claim").filter({ hasText: "install channels" });
    await expect(mobileClaim).toBeVisible();
    await expect(mobileClaim).toContainText(`${LIVE_CHANNELS.length} install channels`);

    // The hero is display:none at this width, not merely off-screen.
    await expect(page.getByTestId("database-showcase-desktop")).toBeHidden();
    await expect(page.getByTestId("hero-proof")).toBeHidden();
  });

  // Issue #541: the relatives line above pushed the hero column past 800px at 1280x800 with
  // zero slack to absorb it, scrolling the whole page. Pinned at the sizes #541 measured as
  // "no scroll" before that line existed, so a future addition to the hero that
  // reopens the gap fails here instead of shipping unnoticed.
  const NO_SCROLL_DESKTOP_VIEWPORTS = [
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];

  test("hero fits without a vertical scrollbar at every no-scroll desktop size", async ({ page }) => {
    for (const viewport of NO_SCROLL_DESKTOP_VIEWPORTS) {
      await page.setViewportSize(viewport);
      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(scrollHeight, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(viewport.height);

      // The sign-in card is the page's one interactive element; it staying reachable without
      // scrolling is the actual user-facing consequence of the hero overflowing.
      const emailBox = await page.locator('input[type="email"]').first().boundingBox();
      expect(emailBox?.y, `${viewport.width}x${viewport.height}`).toBeLessThan(viewport.height);
    }
  });
});
