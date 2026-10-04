/**
 * Passkey sign-in (#785) in a real Chromium against a production build with store-mode storage
 * (docs/PASSKEYS.md, "Signing in"). Runs only under the chromium-passkey project, whose server has
 * PASSKEY_ORIGIN set; see playwright.config.ts.
 *
 * Every test creates its own account through the admin API, so the tests are independent and can
 * run in parallel. The authenticator is a CDP virtual one; the wrong-origin case alone signs in the
 * test runner, because a real browser cannot put a foreign origin into clientDataJSON by design.
 */
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  type PlaywrightWorkerArgs,
  test,
} from "@playwright/test";
import { totpCodeFor } from "../tests/helpers/rfc6238";
import { addVirtualAuthenticator, signAssertion } from "./helpers/virtual-authenticator";

const PASSWORD = "passkey-e2e-password";
const REFUSED = /That passkey could not sign you in\..*Sign in with your password\./;
const SIGN_IN_PATH = "/api/auth/passkey/sign-in";

test.describe.configure({ timeout: 120_000 });

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("the chromium-passkey project sets baseURL");
  return new URL(baseURL).origin;
}

// The proxy refuses a state-changing request without a matching Origin, which a browser always sends.
async function adminApi(playwright: PlaywrightWorkerArgs["playwright"], origin: string): Promise<APIRequestContext> {
  const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  const signedIn = await api.post("/api/auth/login", { data: { email: "admin@libredb.org", password: "test-admin" } });
  expect(signedIn.status()).toBe(200);
  return api;
}

async function createUser(api: APIRequestContext): Promise<string> {
  const email = `passkey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

async function signOut(page: Page): Promise<void> {
  const status = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
  expect(status).toBe(200);
  await page.goto("/login");
}

async function addPasskey(page: Page, name: string, code?: () => string): Promise<void> {
  await page.getByRole("button", { name: "Add passkey" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#passkey-add-name").fill(name);
  await dialog.locator("#passkey-add-password").fill(PASSWORD);
  if (code) await dialog.locator("#passkey-add-code").fill(code());
  else await expect(dialog.locator("#passkey-add-code")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create passkey" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

async function registerPasskey(page: Page, email: string, name = "E2E passkey"): Promise<void> {
  await signInWithPassword(page, email);
  await page.goto("/settings/authenticator");
  await addPasskey(page, name);
}

async function expectPasskeyRefused(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page.getByText(REFUSED)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
}

async function passwordContext(browser: Browser, origin: string, email: string) {
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await signInWithPassword(page, email);
  return { context, page };
}

test("a user adds a passkey and signs in with it, without typing an email", async ({ page, playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  await addVirtualAuthenticator(page);

  await signInWithPassword(page, email);
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Sign-in security" }).click();
  await expect(page).toHaveURL(/\/settings\/authenticator$/);
  await addPasskey(page, "Laptop");

  // Passkeys are ready on this server, so the login page must not deny WebAuthn get to itself.
  const login = await page.request.get("/login");
  const policy = login.headers()["permissions-policy"];
  expect(policy).toContain("camera=()");
  expect(policy).not.toContain("publickey-credentials-get");

  await page.goto("/");
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("#email")).toHaveValue("");
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("a passkey signs in an account that has an authenticator app, without asking for its code", async ({
  page,
  playwright,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  await addVirtualAuthenticator(page);

  await signInWithPassword(page, email);
  await page.goto("/settings/authenticator");
  await page.locator("#authenticator-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await page.getByLabel("Authentication code").fill(totpCodeFor(secret));
  // Turning the authenticator on reloads the passkey section, which then asks for a code as well.
  const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/auth/passkey"));
  await page.getByRole("button", { name: "Confirm code" }).click();
  await reloaded;

  // The next time step: the code that turned the authenticator on is spent.
  await addPasskey(page, "Phone", () => totpCodeFor(secret, Date.now(), 1));

  await signOut(page);
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.locator("#totp")).toBeVisible();
});

test("an assertion without user verification is refused", async ({ page, playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  const authenticator = await addVirtualAuthenticator(page);
  await registerPasskey(page, email);
  await signOut(page);

  await authenticator.overrideBits({ isBadUV: true });
  await expectPasskeyRefused(page);
});

test("a disabled account cannot sign in with its passkey", async ({ page, playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const admin = await adminApi(playwright, origin);
  const email = await createUser(admin);
  await addVirtualAuthenticator(page);
  await registerPasskey(page, email);
  await signOut(page);

  const disabled = await admin.patch(`/api/admin/accounts/${encodeURIComponent(email)}`, { data: { disabled: true } });
  expect(disabled.status()).toBe(200);
  await expectPasskeyRefused(page);
});

test("a removed passkey is refused and ends the account's other sessions", async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  await addVirtualAuthenticator(page);
  await registerPasskey(page, email, "Desk");
  const other = await passwordContext(browser, origin, email);

  await page.getByRole("button", { name: "Remove Desk" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.locator("#passkey-remove-password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Remove passkey" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("No passkeys yet.", { exact: false })).toBeVisible();

  // The editor is where a refused session is sent back to /login (src/hooks/use-auth.ts), with the
  // page it was on as the return path (#1420).
  await other.page.goto("/");
  await expect(other.page).toHaveURL(/\/login\?next=%2F$/);
  await other.context.close();

  // The caller's own session survives: this page never redirects, so prove it through a read the
  // server refuses for a dead session, and through the list that only renders when that read passed.
  const status = await page.evaluate(async () => (await fetch("/api/auth/passkey")).status);
  expect(status).toBe(200);
  await page.reload();
  await expect(page.getByText("No passkeys yet.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("passkeys-error")).toHaveCount(0);
  await signOut(page);
  await expectPasskeyRefused(page);
});

test("an assertion made for another origin is refused, and the login page on another address offers no passkey", async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  const authenticator = await addVirtualAuthenticator(page);
  await registerPasskey(page, email);
  const [credential] = await authenticator.credentials();
  expect(credential.isResidentCredential).toBe(true);
  await context.clearCookies();

  async function attempt(signedOrigin: string): Promise<number> {
    const offered = await page.request.post(SIGN_IN_PATH, { data: { action: "options" }, headers: { Origin: origin } });
    expect(offered.status()).toBe(200);
    const { options } = await offered.json();
    const response = signAssertion(credential, options, signedOrigin);
    const verified = await page.request.post(SIGN_IN_PATH, {
      data: { action: "verify", response },
      headers: { Origin: origin },
    });
    return verified.status();
  }

  // The request itself comes from the right origin; only the signed clientDataJSON names another.
  expect(await attempt("http://localhost:3099")).toBe(401);
  // The positive control: the same key and the same flow with the right origin is accepted.
  expect(await attempt(origin)).toBe(200);

  const loopback = new URL(origin);
  loopback.hostname = "127.0.0.1";
  await page.goto(new URL("/login", loopback).href);
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Use a passkey" })).toHaveCount(0);
});

test("an admin removes every passkey of an account with a typed confirmation", async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  const email = await createUser(await adminApi(playwright, origin));
  await addVirtualAuthenticator(page);
  await registerPasskey(page, email);
  await signOut(page);

  const adminContext = await browser.newContext({ baseURL: origin });
  const signedIn = await adminContext.request.post("/api/auth/login", {
    data: { email: "admin@libredb.org", password: "test-admin" },
    headers: { Origin: origin },
  });
  expect(signedIn.status()).toBe(200);
  const admin = await adminContext.newPage();
  await admin.goto("/admin/accounts");
  await expect(admin.getByTestId(`passkeys-${email}`)).toContainText("1");
  await admin.getByRole("button", { name: `Actions for ${email}` }).click();
  await admin.getByTestId(`clear-passkeys-${email}`).click();
  const dialog = admin.getByRole("alertdialog");
  await dialog.getByRole("textbox").fill(email);
  await dialog.getByRole("button", { name: "Remove passkeys" }).click();
  await expect(dialog).toBeHidden();
  await expect(admin.getByTestId(`passkeys-${email}`)).toContainText("None");
  await adminContext.close();

  await expectPasskeyRefused(page);
});
