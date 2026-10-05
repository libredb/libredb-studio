import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";

// The JWT_SECRET playwright.config.ts gives the server, so the test can sign a token that the
// proxy accepts as genuine and refuses only because it has expired.
const JWT_SECRET = new TextEncoder().encode("test-jwt-secret-for-e2e-tests-32ch");

async function signIn(page: Page) {
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
}

async function runQuery(page: Page, sql: string) {
  await page.evaluate((text) => {
    const monaco = (window as unknown as { monaco: { editor: { getEditors(): { setValue(value: string): void }[] } } })
      .monaco;
    monaco.editor.getEditors()[0].setValue(text);
  }, sql);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
}

// #1420: an expired session used to answer every API call with a redirect to the sign-in page's
// HTML, so the editor showed "Unexpected token '<' ... is not valid JSON" and stayed put.
test("an expired session sends the user to sign in and back to where they were", async ({ page, context }) => {
  await page.goto("/login");
  await signIn(page);
  await page.waitForURL("/");
  await page.getByText("Sample (LibreDB)", { exact: true }).first().click();
  await page.waitForFunction(
    () =>
      ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length ??
        0) > 0,
  );
  await runQuery(page, "prefix users:");
  await expect(page.getByText("Ada").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });

  const expired = await new SignJWT({ role: "user", username: "user@libredb.org" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(JWT_SECRET);
  const [cookie] = (await context.cookies()).filter((value) => value.name === "auth-token");
  await context.addCookies([{ ...cookie, value: expired }]);

  const refused = page.waitForResponse((response) => response.url().endsWith("/api/db/query"));
  await runQuery(page, "prefix articles:");
  const response = await refused;
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Session expired. Sign in again.", code: "AUTH_REQUIRED" });

  await page.waitForURL("/login?next=%2F");
  await expect(page.getByText("Unexpected token")).toHaveCount(0);

  await signIn(page);
  await page.waitForURL("/");
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
});

test("a role refusal on an admin API keeps its message and does not sign the user out", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await page.waitForURL("/");

  const refusal = await page.evaluate(async () => {
    const response = await fetch("/api/admin/audit");
    return { status: response.status, body: await response.json() };
  });
  expect(refusal).toEqual({ status: 403, body: { error: "Unauthorized. Admin access required." } });
  await expect(page).toHaveURL("/");
});
