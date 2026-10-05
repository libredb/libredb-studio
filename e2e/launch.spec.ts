/**
 * Launch-token sign-in (docs/LAUNCH.md) in a real Chromium against a production build in store mode. A token
 * minted here, as a platform mints one, signs a person Studio has never seen in through /launch and opens the
 * connection it names. Runs only under the chromium-launch project, whose server has the LAUNCH_TOKEN_*
 * variables and the two seeded connections of e2e/fixtures/launch-seed-connections.json; see
 * playwright.config.ts.
 *
 * Opening the named connection is the editor's ?connection= deep link, which lands before launch sign-in on
 * this branch; it removes the parameter once the connection is open, so the editor's bare URL is the end state.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mintLaunchToken } from "./helpers/launch-token";

test.describe.configure({ timeout: 120_000 });

function uniqueEmail(): string {
  return `launch-${randomUUID()}@example.com`;
}

test("a launch link signs a new person in and opens the connection it names", async ({ page }) => {
  const email = uniqueEmail();
  const token = await mintLaunchToken({ email, role: "user", conn: "launch-target" });

  await page.goto(`/launch#token=${token}`);

  // With no Studio session the page names the account and signs in only on a click.
  await expect(page.getByText(`This launch link signs you in to LibreDB Studio as ${email}.`)).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  await page.getByRole("button", { name: `Continue as ${email}` }).click();

  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  expect(page.url()).not.toContain(token);
  // The first seeded connection is the default selection, so seeing the second one proves the link chose it.
  await expect(page.getByRole("heading", { level: 1, name: "Launch Target" }).first()).toBeVisible({
    timeout: 15_000,
  });

  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ authenticated: true, user: { role: "user", username: email } });
});

test("a launch link used twice says so and offers the password sign-in", async ({ page, request }) => {
  const email = uniqueEmail();
  const token = await mintLaunchToken({ email, role: "user" });
  const first = await request.post("/api/auth/launch", { data: { token } });
  expect(first.status()).toBe(200);

  await page.goto(`/launch#token=${token}`);
  await page.getByRole("button", { name: `Continue as ${email}` }).click();

  await expect(
    page.getByText("This launch link has already been used. Open Studio again to get a new one."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  await expect(page).toHaveURL(/\/launch$/);
});

test("a launch link for someone else, opened while signed in, names both accounts and keeps the session", async ({
  page,
}) => {
  const signedIn = uniqueEmail();
  const other = uniqueEmail();
  await page.goto(`/launch#token=${await mintLaunchToken({ email: signedIn, role: "user" })}`);
  await page.getByRole("button", { name: `Continue as ${signedIn}` }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

  // Signed in now, so the second link posts at once and the route answers 409: no Continue to click.

  await page.goto(
    `/launch#token=${await mintLaunchToken({ email: other, role: "user", sub: "another-platform-user" })}`,
  );

  await expect(page.getByRole("heading", { name: "You are already signed in to Studio" })).toBeVisible();
  await expect(
    page.getByText(`This browser is signed in as ${signedIn}, and the launch link was for ${other}.`),
  ).toBeVisible();
  const me = await page.request.get("/api/auth/me");
  expect(await me.json()).toMatchObject({ authenticated: true, user: { username: signedIn } });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByText(`You are signed out. Open Studio again from the platform to continue as ${other}.`),
  ).toBeVisible();
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});
