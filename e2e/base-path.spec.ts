import { expect, test } from "@playwright/test";

const prefix = "/~/libredb";

test("production deployment behind a path-preserving reverse proxy", async ({ page, context, request, baseURL }) => {
  const failedAppRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().startsWith(baseURL!) && response.status() >= 400)
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
  await page.goto(`${prefix}/admin`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/?$`));

  expect((await request.get(`${prefix}/logo.svg`)).status()).toBe(200);
  expect((await request.get(`${prefix}/monaco/vs/loader.js`)).status()).toBe(200);
  expect(failedAppRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

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
