import { type Cookie, expect, test } from "@playwright/test";
import { addVirtualAuthenticator } from "./helpers/virtual-authenticator";

const prefix = "/~/libredb";

test("production deployment behind a path-preserving reverse proxy", async ({ page, context, request, baseURL }) => {
  const failedAppRequests: string[] = [];
  const pageErrors: string[] = [];
  // Set while the test is signed out behind the editor's back (the logout below is a bare fetch, so
  // the editor stays mounted). Its in-flight calls then get the session-required 401 an API path
  // answers without a session (#1420); before that they got a redirect, which this check never saw.
  let signedOut = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (!response.url().startsWith(baseURL!) || response.status() < 400) return;
    if (signedOut && response.status() === 401) return;
    failedAppRequests.push(`${response.status()} ${response.url()}`);
  });
  await page.route("**/*", (route) => (route.request().url().startsWith(baseURL!) ? route.continue() : route.abort()));

  // The proxy makes escaping the prefix observable instead of letting root URLs work by accident.
  expect((await request.get("/api/db/health")).status()).toBe(404);
  expect((await request.get(`${prefix}-other/api/db/health`)).status()).toBe(404);
  expect((await request.get(`${prefix}/api/db/health`)).status()).toBe(200);
  expect(
    (
      await request.post(`${prefix}/api/db/health`, { headers: { origin: "https://untrusted.example" }, data: {} })
    ).status(),
  ).toBe(403);
  const rootRedirect = await request.get(prefix, { maxRedirects: 0 });
  expect(new URL(rootRedirect.headers().location, baseURL).href).toBe(`${baseURL}${prefix}/login`);
  const redirect = await request.get(`${prefix}/admin`, { maxRedirects: 0 });
  expect(new URL(redirect.headers().location, baseURL).href).toBe(`${baseURL}${prefix}/login`);
  const oidcError = await request.get(`${prefix}/api/auth/oidc/login`, { maxRedirects: 0 });
  expect(new URL(oidcError.headers().location, baseURL).href).toBe(`${baseURL}${prefix}/login?error=oidc_config`);

  await page.goto(`${prefix}/login`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", `${prefix}/site.webmanifest`);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", `${prefix}/apple-touch-icon.png`);
  const manifestResponse = await request.get(`${prefix}/site.webmanifest`);
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as { start_url: string; icons: { src: string }[] };
  expect(new URL(manifest.start_url, `${baseURL}${prefix}/site.webmanifest`).pathname).toBe(`${prefix}/`);
  for (const icon of manifest.icons) {
    expect((await request.get(new URL(icon.src, `${baseURL}${prefix}/site.webmanifest`).pathname)).status()).toBe(200);
  }
  expect((await request.get(`${prefix}/apple-touch-icon.png`)).status()).toBe(200);

  await page.locator('input[type="email"]:visible').fill("user@libredb.org");
  await page.locator('input[type="password"]:visible').fill("test-user");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(new RegExp(`${prefix}/?$`));
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
  const cookie = (await context.cookies()).find((value) => value.name === "auth-token");
  expect(cookie).toMatchObject({ path: prefix, httpOnly: true, sameSite: "Lax" });

  await page.getByText("Sample (Employees)", { exact: true }).first().click();
  await page.waitForFunction(
    () =>
      ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length ??
        0) > 0,
  );
  await page.evaluate(() => {
    const monaco = (window as unknown as { monaco: { editor: { getEditors(): { setValue(value: string): void }[] } } })
      .monaco;
    monaco.editor.getEditors()[0].setValue("SELECT COUNT(*) AS employee_count FROM employee");
  });
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByText("employee_count", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("1000", { exact: true }).first()).toBeVisible();

  const session = await page.evaluate(async (path) => (await fetch(`${path}/api/auth/me`)).json(), prefix);
  expect(session.user.role).toBe("user");
  // The redirect lands on the editor, which checks the active connection's health once it mounts.
  // Wait for that check here: sent after the logout below, it would carry no cookie and answer 401.
  const pulse = page.waitForResponse(
    (response) => response.url().endsWith(`${prefix}/api/db/health`) && response.request().method() === "POST",
  );
  await page.goto(`${prefix}/admin`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/?$`));
  expect((await pulse).status()).toBe(200);

  expect((await request.get(`${prefix}/logo.svg`)).status()).toBe(200);
  expect((await request.get(`${prefix}/monaco/vs/loader.js`)).status()).toBe(200);
  expect(failedAppRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

  signedOut = true;
  const logoutStatus = await page.evaluate(
    async (path) => (await fetch(`${path}/api/auth/logout`, { method: "POST" })).status,
    prefix,
  );
  expect(logoutStatus).toBe(200);
  expect((await context.cookies()).some((value) => value.name === "auth-token")).toBe(false);
  await page.goto(`${prefix}/`);
  await expect(page).toHaveURL(`${baseURL}${prefix}/login`);

  await page.locator('input[type="email"]:visible').fill("admin@libredb.org");
  await page.locator('input[type="password"]:visible').fill("test-admin");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(`${baseURL}${prefix}/admin/overview`);
  signedOut = false;
  await expect(page.getByTestId("admin-content-overview")).toBeVisible();
  // Server redirects, Next links and native quick actions all stay inside the mount.
  await expect(page.getByRole("link", { name: "Operations", exact: true })).toHaveAttribute(
    "href",
    `${prefix}/admin/operations`,
  );
  const maintenance = page.getByRole("link", { name: /^Maintenance VACUUM/ });
  await expect(maintenance).toHaveAttribute("href", `${prefix}/admin/operations`);
  await maintenance.click();
  await expect(page).toHaveURL(`${baseURL}${prefix}/admin/operations`);
  await page.goto(`${prefix}/admin?tab=audit`);
  await expect(page).toHaveURL(`${baseURL}${prefix}/admin/audit`);
  expect(failedAppRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}${prefix}/login`);
  expect((await context.cookies()).some((value) => value.name === "auth-token")).toBe(false);
});

test("a passkey registers and signs in under the base path", async ({ page, context, baseURL }) => {
  // WebAuthn accepts plain http only on the host name localhost, so this test leaves baseURL's 127.0.0.1.
  const origin = new URL(baseURL!);
  origin.hostname = "localhost";
  const studio = `${origin.origin}${prefix}`;
  // The editor answers at the prefix with or without its trailing slash, as in the test above.
  const editor = new RegExp(`^${origin.origin}${prefix}/?$`);
  await addVirtualAuthenticator(page);

  await page.goto(`${studio}/login`);
  await page.locator('input[type="email"]:visible').fill("user@libredb.org");
  await page.locator('input[type="password"]:visible').fill("test-user");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(editor);
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Sign-in security" }).click();
  await expect(page).toHaveURL(`${studio}/settings/authenticator`);

  // Read between the options and the verify request, while the ceremony cookie exists.
  let ceremonyCookie: Cookie | undefined;
  await page.route(
    (url) => url.pathname === `${prefix}/api/auth/passkey`,
    async (route) => {
      if (route.request().postDataJSON()?.action === "register-verify") {
        ceremonyCookie = (await context.cookies()).find((cookie) => cookie.name === "passkey-registration");
      }
      await route.continue();
    },
  );
  await page.getByRole("button", { name: "Add passkey" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#passkey-add-name").fill("Base path");
  await dialog.locator("#passkey-add-password").fill("test-user");
  await dialog.getByRole("button", { name: "Create passkey" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Base path", { exact: true })).toBeVisible();
  expect(ceremonyCookie).toMatchObject({ path: `${prefix}/api/auth/passkey`, httpOnly: true, sameSite: "Strict" });

  const logoutStatus = await page.evaluate(
    async (path) => (await fetch(`${path}/api/auth/logout`, { method: "POST" })).status,
    prefix,
  );
  expect(logoutStatus).toBe(200);
  await page.goto(`${studio}/login`);
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page).toHaveURL(editor);
});
