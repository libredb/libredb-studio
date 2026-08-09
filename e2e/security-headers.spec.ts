/**
 * Threat: a Content-Security-Policy that silently breaks the editor or the export pipeline.
 *
 * A CSP failure is usually not a thrown error. Without font-src data: the editor keeps working
 * while every codicon glyph disappears; without img-src data: the PNG and SVG exports fail inside
 * a promise nobody awaits. So this spec does not assert "the page looks fine" — it installs a
 * securitypolicyviolation collector before any document script runs and drives the whole asset
 * surface: Monaco, the theme, a query, the ELK layout worker, and both export formats.
 *
 * securitypolicyviolation fires for report-only policies as well as enforced ones, which is what
 * makes the report-only stage produce evidence rather than hope. It is also deterministic, unlike
 * matching console text.
 */
import { expect, test, type Page } from "@playwright/test";

const CSP_HEADER = "content-security-policy";

interface Violation {
  directive: string;
  blocked: string;
}

async function installViolationCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sink: { directive: string; blocked: string }[] = [];
    (window as unknown as { __cspViolations: typeof sink }).__cspViolations = sink;
    document.addEventListener("securitypolicyviolation", (event) => {
      sink.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
}

async function readViolations(page: Page): Promise<Violation[]> {
  return await page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

test.describe("Content-Security-Policy against the real asset surface", () => {
  // Login, the async SQLite seed, Monaco, the ELK layout and two snapdom captures.
  test.describe.configure({ timeout: 240_000 });

  test("drives the editor, a query, the diagram and both exports with no policy violation", async ({ page }) => {
    await installViolationCollector(page);

    const loginResponse = await page.goto("/login");
    expect(loginResponse).not.toBeNull();
    const loginPolicy = loginResponse?.headers()[CSP_HEADER];
    expect(loginPolicy).toContain("default-src 'self'");
    expect(loginPolicy).toContain("frame-ancestors 'none'");
    expect(loginPolicy).toContain("worker-src 'self'");

    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    // The login document has its own violation array; assert it before navigating away.
    expect(await readViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");

    // Monaco: script-src, style-src (the db-dark theme injects <style>), font-src (codicons).
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(
      () =>
        ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors()
          .length ?? 0) > 0,
    );

    const sample = page.locator("text=Sample (Employees)").first();
    await expect(sample).toBeVisible({ timeout: 45_000 });
    await sample.click();

    // connect-src: the query round trip.
    await page.evaluate(() => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      if (!monaco) throw new Error("monaco global not found");
      monaco.editor.getEditors()[0].setValue("SELECT COUNT(*) AS employee_count FROM employee");
    });
    await page.getByRole("button", { name: "RUN" }).click();
    await expect(page.locator("text=employee_count").first()).toBeVisible({ timeout: 20_000 });

    // worker-src: the ELK layout worker runs when the diagram opens.
    await page.getByTitle("Show ERD Diagram").click();
    await expect(page.getByRole("button", { name: "PNG" })).toBeVisible({ timeout: 30_000 });

    // img-src data: snapdom rasterizes through a data:image/svg+xml URL for both formats.
    const [pngDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "PNG" }).click(),
    ]);
    expect(pngDownload.suggestedFilename()).toMatch(/^erd_\d+\.png$/);

    const [svgDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "SVG" }).click(),
    ]);
    expect(svgDownload.suggestedFilename()).toMatch(/^erd_\d+\.svg$/);

    expect(await readViolations(page)).toEqual([]);
  });
});
