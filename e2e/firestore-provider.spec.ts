import { expect, type Page, test } from "@playwright/test";
import { type FirestoreStub, startFirestoreStub } from "./helpers/firestore-stub";

/**
 * The Firestore provider in a browser, against a stub that replays the emulator captures of tests/fixtures/firestore/
 * (e2e/helpers/firestore-stub.ts) on the loopback port this server's FIRESTORE_EMULATOR_HOST names: connect with an
 * empty credential and see the emulator warning, preview a collection, expand its sampled fields, walk the Keys
 * panel to a document, open it in the Source tab, and run a count in the console. Every request the server sends
 * must be recorded and carry `Bearer owner`. The stub binds a fixed port, so the tests run in one worker, in order.
 */
test.describe.configure({ mode: "serial" });

let stub: FirestoreStub;

test.beforeAll(async () => {
  stub = await startFirestoreStub();
});

test.afterAll(async () => {
  await stub.close();
});

function treeRow(page: Page, label: string) {
  return page
    .locator('[role="treeitem"]')
    .filter({ has: page.getByTestId("tree-row-label").getByText(label, { exact: true }) })
    .first();
}

function resultsGrid(page: Page) {
  return page.locator("[data-desktop-grid]").filter({ visible: true }).first();
}

async function editorText(page: Page, inSource: boolean): Promise<string> {
  return page.evaluate((source) => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): { getValue(): string; getDomNode(): Element | null }[] } };
      }
    ).monaco;
    if (!monaco) throw new Error("monaco global not found");
    const editor = monaco.editor
      .getEditors()
      .find((candidate) => (candidate.getDomNode()?.closest('[data-testid="object-source-view"]') !== null) === source);
    return editor === undefined ? "" : editor.getValue();
  }, inSource);
}

async function runStatement(page: Page, statement: string) {
  await page.evaluate((text) => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): { setValue(v: string): void; getDomNode(): Element | null }[] } };
      }
    ).monaco;
    if (!monaco) throw new Error("monaco global not found");
    const query = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.closest('[data-testid="object-source-view"]') === null);
    if (!query) throw new Error("query editor not found");
    query.setValue(text);
  }, statement);
  await page.getByRole("button", { name: "RUN" }).click();
}

test("connects to the stub with no credential, then browses the tree, the Keys panel, the Source tab and the console", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@libredb.org");
  await page.locator('input[type="password"]').fill("test-admin");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10_000 });
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByRole("button", { name: "Firestore", exact: true }).click();
  await dialog.locator("#database").fill("demo-libredb");

  const establish = dialog.getByRole("button", { name: "Establish Connection" });
  await establish.click();
  await expect(
    dialog.getByText(`Connected to the Firestore emulator at 127.0.0.1:${stub.port}, not to Google`),
  ).toBeVisible({
    timeout: 20_000,
  });
  await establish.click();
  await expect(dialog).not.toBeVisible({ timeout: 20_000 });

  // The tree: top-level collections under their group; activating one previews it with the generated statement.
  await expect(treeRow(page, "Collections")).toBeVisible({ timeout: 20_000 });
  await treeRow(page, "Collections").click();
  await expect(treeRow(page, "Collections")).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
  await expect(treeRow(page, "users")).toBeVisible({ timeout: 20_000 });
  await treeRow(page, "users").click();
  await expect(resultsGrid(page).getByText("Alice", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // A field expand samples the collection; age is an integer in two documents and a string in one.
  await treeRow(page, "users").getByTestId("tree-row-twisty").click();
  await expect(treeRow(page, "age")).toBeVisible({ timeout: 20_000 });
  await expect(treeRow(page, "age").getByTestId("tree-row-column-type")).toContainText("mixed(integer|string)");

  // The Keys panel: the root level, then the users level, then alice opens in the Source tab.
  await page.getByRole("tab", { name: "Keys" }).click();
  const keys = page.getByRole("tree", { name: "Keys" });
  await expect(keys.locator('[role="treeitem"][title="users/"]')).toBeVisible({ timeout: 20_000 });
  await keys.getByLabel("Expand users", { exact: true }).click();
  const alice = keys.locator('[role="treeitem"][title="users/alice is a key and a folder: users/alice/"]');
  await expect(alice).toBeVisible({ timeout: 20_000 });
  await alice.click();
  await expect(page.getByTestId("object-source-view")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => editorText(page, true), { timeout: 20_000 }).toContain("Istanbul");

  // The console: a count, which Firestore answers from the index.
  await page.getByRole("tab", { name: "Objects" }).click();
  await page.getByRole("tab", { name: "Query 1" }).click();
  await runStatement(page, 'db.collection("orders").count()');
  await expect(resultsGrid(page).getByText("5", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  expect(stub.unrecorded).toEqual([]);
  expect(stub.unauthorized).toEqual([]);
  expect(stub.requests.length).toBeGreaterThan(0);
});
