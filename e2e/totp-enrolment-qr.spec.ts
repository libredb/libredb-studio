/**
 * Enrolment QR decodes to the server otpauth URL (#1826). Runs only under chromium-passkey
 * (store-mode storage for TOTP); see playwright.config.ts.
 */
import { expect, test, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { decodeEnrolmentQrPngBuffer } from "./helpers/decode-enrolment-qr-png";

const PASSWORD = "passkey-e2e-password";
const TOTP_QR_TEST_ID = "totp-qr";

test.describe.configure({ timeout: 120_000 });

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("the chromium-passkey project sets baseURL");
  return new URL(baseURL).origin;
}

async function adminApi(playwright: PlaywrightWorkerArgs["playwright"], origin: string): Promise<APIRequestContext> {
  const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  const signedIn = await api.post("/api/auth/login", { data: { email: "admin@libredb.org", password: "test-admin" } });
  expect(signedIn.status()).toBe(200);
  return api;
}

async function createUser(api: APIRequestContext): Promise<string> {
  const email = `totp-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await api.post("/api/admin/accounts", { data: { email, password: PASSWORD, role: "user" } });
  expect(created.status()).toBe(201);
  return email;
}

async function signInWithPassword(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function startTotpEnrolment(page: Page): Promise<string> {
  await page.goto("/settings/authenticator");
  await page.locator("#authenticator-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await expect(page.getByTestId("totp-secret")).toBeVisible();
  const link = page.locator('a[href^="otpauth://"]').first();
  await expect(link).toBeVisible();
  const otpauthUrl = await link.getAttribute("href");
  expect(otpauthUrl).toMatch(/^otpauth:\/\//);
  return otpauthUrl ?? "";
}

async function expectScreenshotDecodesTo(page: Page, otpauthUrl: string): Promise<void> {
  const qr = page.getByTestId(TOTP_QR_TEST_ID);
  await expect(qr).toBeVisible();
  const pngBytes = await qr.screenshot();
  expect(decodeEnrolmentQrPngBuffer(pngBytes)).toBe(otpauthUrl);
}

async function prepareUser(page: Page, playwright: PlaywrightWorkerArgs["playwright"], baseURL: string | undefined) {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  await signInWithPassword(page, email);
  return email;
}

/** next-themes reads `libredb-theme` and sets `class="dark"` on <html> (see theme-provider.tsx). */
async function setStudioTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem("libredb-theme", value);
  }, theme);
  await page.reload();
}

async function expectStudioDark(page: Page, dark: boolean): Promise<void> {
  if (dark) await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
}

test("the enrolment QR PNG decodes to the otpauth link in light theme", async ({ page, playwright, baseURL }) => {
  await prepareUser(page, playwright, baseURL);
  await setStudioTheme(page, "light");
  await expectStudioDark(page, false);
  const otpauthUrl = await startTotpEnrolment(page);
  await expectStudioDark(page, false);
  await expectScreenshotDecodesTo(page, otpauthUrl);
});

test("the enrolment QR PNG decodes to the otpauth link in dark theme", async ({ page, playwright, baseURL }) => {
  await prepareUser(page, playwright, baseURL);
  await setStudioTheme(page, "dark");
  await expectStudioDark(page, true);
  const otpauthUrl = await startTotpEnrolment(page);
  await expectStudioDark(page, true);
  await expectScreenshotDecodesTo(page, otpauthUrl);
});
