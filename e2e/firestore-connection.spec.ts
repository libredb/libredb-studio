import { expect, type Page, test } from "@playwright/test";
import { validateFirestoreConnection } from "../src/lib/db/providers/document/firestore/connection-options";
import { resolveFirestoreAuth } from "../src/lib/db/providers/document/firestore/credential-policy";
import { resolveSeams } from "../src/lib/db/providers/document/firestore/seams";

/**
 * The Firestore connection dialog in a browser: the driver is offered, its three fields carry spec 4.1's labels and
 * hint, and Test Connection refuses before any socket an empty credential, a credential type Studio does not take and
 * a project id the id rule refuses. It runs on the second server, which sets no FIRESTORE_EMULATOR_HOST, so these are
 * the refusals a Google connection meets. Each expected sentence is computed from the module that raises it.
 */

/** The sentence a function throws, so the browser is checked against the code's own words. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

const EXTERNAL_ACCOUNT = JSON.stringify({
  type: "external_account",
  audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://sts.googleapis.com/v1/token",
  credential_source: { url: "http://169.254.169.254/token" },
});

async function openFirestore(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10_000 });
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByRole("button", { name: "Firestore", exact: true }).click();
  return dialog;
}

test.describe("Firestore in the connection dialog", () => {
  test("offers three fields with spec 4.1's labels and the IAM hint, and no host, port or connection string", async ({
    page,
  }) => {
    const dialog = await openFirestore(page);
    for (const id of ["#database", "#schema", "#password"]) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its id.
      await expect(dialog.locator(id)).toBeVisible();
    }
    await expect(dialog.getByText("Project ID", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Database ID", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Security Rules do not apply/)).toBeVisible();
    await expect(dialog.getByText(/roles\/datastore\.viewer/)).toBeVisible();
    await expect(dialog.locator("#host")).toHaveCount(0);
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("an empty credential is refused with the browser sentence", async ({ page }) => {
    const dialog = await openFirestore(page);
    await dialog.locator("#database").fill("demo-libredb");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      "Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is used only for operator-seeded connections",
      { timeout: 15_000 },
    );
  });

  test("an external_account credential is refused before any socket, and its URLs never reach the page", async ({
    page,
  }) => {
    const expected = refusal(() =>
      resolveFirestoreAuth({ password: EXTERNAL_ACCOUNT, managed: false }, resolveSeams({ env: {} })),
    );
    const dialog = await openFirestore(page);
    await dialog.locator("#database").fill("demo-libredb");
    await dialog.locator("#password").fill(EXTERNAL_ACCOUNT);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(expected, { timeout: 15_000 });
    await expect(result).not.toContainText("169.254.169.254");
  });

  test("a project id the rule refuses is refused with the rule's sentence", async ({ page }) => {
    const [expected] = validateFirestoreConnection({ database: "Bad_Project" });
    expect(expected).toBeDefined();
    const dialog = await openFirestore(page);
    await dialog.locator("#database").fill("Bad_Project");
    await dialog.locator("#password").fill("ya29.e2e-token-value-0123456789");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(dialog.getByTestId("connection-test-result")).toContainText(expected ?? "", { timeout: 15_000 });
  });
});
