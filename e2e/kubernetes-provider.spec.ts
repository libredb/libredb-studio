import { expect, type Page, test } from "@playwright/test";
import { forbiddenSentence } from "../src/lib/db/providers/platform/kubernetes/errors";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../tests/helpers/kubernetes-markers";
import { type GridFact, READER_STATEMENT_FACTS, READER_STATEMENTS } from "../tests/live/kubernetes-evidence-plan";
import { type KubernetesStub, STUB_TOKENS, startKubernetesStub } from "./helpers/kubernetes-stub";

/**
 * The Kubernetes provider in a browser, against a stub API server that replays the v1.35.5 captures of
 * tests/fixtures/kubernetes/ over https on a loopback port (e2e/helpers/kubernetes-stub.ts): import a kubeconfig, browse
 * the tree, open a YAML view, run Describe and Logs from a pod's row menu and Logs from a click on its row, run every
 * console command once, see a locked kind, and see a Secret with no value. It runs on the second server, as every spec
 * that connects does, and signs in as the admin for the reason e2e/neo4j-provider.spec.ts gives. The tokens are the
 * stub's own stand-ins.
 */

/**
 * The console runs every statement the reader's capture holds, each checked against the fact of the sample data its grid
 * must show (`READER_STATEMENT_FACTS`, the same facts the capture harness and the integration test check), inside the
 * results grid of the run and only once that grid has changed, so the editor, the history and an earlier grid never
 * answer for it.
 */
const CONSOLE = READER_STATEMENTS;
const SECRET_FORMS = [M.secretValue, Buffer.from(M.secretValue, "utf8").toString("base64")] as const;
const LAST_APPLIED = "last-applied-configuration";

let stub: KubernetesStub;

test.beforeAll(async () => {
  stub = await startKubernetesStub();
});

test.afterAll(async () => {
  await stub.close();
});

async function signInAndOpenDialog(page: Page) {
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
  await dialog.getByRole("button", { name: "Kubernetes", exact: true }).click();
  return dialog;
}

function kubeconfig(token: string, name: string): string {
  return `apiVersion: v1
kind: Config
current-context: ${name}
clusters:
  - name: stub
    cluster:
      server: https://127.0.0.1:${stub.port}
      certificate-authority-data: ${Buffer.from(stub.caPem, "utf8").toString("base64")}
users:
  - name: ${name}
    user:
      token: ${token}
contexts:
  - name: ${name}
    context:
      cluster: stub
      user: ${name}
      namespace: shop
`;
}

/**
 * The warning the persona's first Establish Connection shows, after which a second one saves: the reader may list the
 * Secrets of shop (the Secret test reads one), and shop-only may not list namespaces, so its tree shows shop alone.
 */
const WARNED: Readonly<Record<keyof typeof STUB_TOKENS, RegExp | undefined>> = Object.freeze({
  reader: /read every Secret value in the namespace shop/,
  viewer: undefined,
  shopOnly: /may not list namespaces, so the tree shows the Default namespace \(shop\) alone/,
});

/** Imports the persona's kubeconfig into a new connection and connects. */
async function connectAs(page: Page, persona: keyof typeof STUB_TOKENS) {
  const dialog = await signInAndOpenDialog(page);
  await dialog.getByTestId("connection-import-open").click();
  await dialog.getByTestId("connection-import-text").fill(kubeconfig(STUB_TOKENS[persona], `e2e-${persona}`));
  await dialog.getByTestId("connection-import-read").click();
  await dialog.getByTestId("connection-import-context").first().click();
  const establish = dialog.getByRole("button", { name: "Establish Connection" });
  await establish.click();
  const warning = WARNED[persona];
  if (warning !== undefined) {
    await expect(dialog.getByText(warning)).toBeVisible({ timeout: 20_000 });
    await establish.click();
  }
  await expect(dialog).not.toBeVisible({ timeout: 20_000 });
  await expect(row(page, "Cluster")).toBeVisible({ timeout: 20_000 });
}

function row(page: Page, label: string) {
  return page
    .locator('[role="treeitem"]')
    .filter({ has: page.getByTestId("tree-row-label").getByText(label, { exact: true }) })
    .first();
}

/** Opens each row in turn; the connection's default namespace is open already, so a row open already is not clicked. */
async function open(page: Page, ...labels: string[]) {
  for (const label of labels) {
    if ((await row(page, label).getAttribute("aria-expanded")) !== "true") await row(page, label).click();
    await expect(row(page, label)).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
  }
}

/** The results grid of the active tab, the one scope every grid check reads. */
function resultsGrid(page: Page) {
  return page.locator("[data-desktop-grid]").filter({ visible: true }).first();
}

async function gridText(page: Page): Promise<string> {
  const grid = resultsGrid(page);
  return (await grid.count()) === 0 ? "" : grid.innerText();
}

/** Waits until the grid is no longer `before`, then for the fact: a whole cell, or a part of the grid's text. */
async function expectGridShows(page: Page, fact: GridFact, before: string, what: string) {
  await expect.poll(() => gridText(page), { message: what, timeout: 20_000 }).not.toBe(before);
  const grid = resultsGrid(page);
  if ("cell" in fact) {
    await expect(grid.getByText(fact.cell, { exact: true }).first(), what).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(grid, what).toContainText(fact.within, { timeout: 20_000 });
  }
}

/** The whole text of the YAML view's editor. */
async function sourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): { getValue(): string; getDomNode(): Element | null }[] } };
      }
    ).monaco;
    if (!monaco) throw new Error("monaco global not found");
    const view = document.querySelector('[data-testid="object-source-view"]');
    const editor = monaco.editor.getEditors().find((candidate) => {
      const node = candidate.getDomNode();
      return view !== null && node !== null && view.contains(node);
    });
    return editor === undefined ? "" : editor.getValue();
  });
}

/** The query editor's text, never the YAML view's editor's. */
async function queryText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): { getValue(): string; getDomNode(): Element | null }[] } };
      }
    ).monaco;
    if (!monaco) throw new Error("monaco global not found");
    const query = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.closest('[data-testid="object-source-view"]') === null);
    return query === undefined ? "" : query.getValue();
  });
}

/** Types the statement into the query editor, never the YAML view's editor, and runs it. */
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

/** Waits until the stub has answered no new request for a second, so a count taken next is not still moving. */
async function requestsSettled(): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const seen = last;
        last = stub.requests.length;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return stub.requests.length === seen;
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBe(true);
  return stub.requests.length;
}

test.describe.configure({ mode: "serial" });

test.describe("Kubernetes against a replayed API server", () => {
  test("a pasted kubeconfig fills the dialog: host, port, token, default namespace and the CA", async ({ page }) => {
    const dialog = await signInAndOpenDialog(page);
    await dialog.getByTestId("connection-import-open").click();
    await dialog.getByTestId("connection-import-text").fill(kubeconfig(STUB_TOKENS.reader, "e2e-reader"));
    await dialog.getByTestId("connection-import-read").click();
    await dialog.getByTestId("connection-import-context").first().click();
    await expect(dialog.locator("#host")).toHaveValue("127.0.0.1");
    await expect(dialog.locator("#port")).toHaveValue(String(stub.port));
    await expect(dialog.locator("#password")).toHaveValue(STUB_TOKENS.reader);
    await expect(dialog.locator("#database")).toHaveValue("shop");
    await expect(dialog.getByPlaceholder(/Paste CA cert content here/)).toHaveValue(stub.caPem);
  });

  test("the tree shows Cluster and the namespaces, and a Deployment opens as YAML", async ({ page }) => {
    await connectAs(page, "reader");
    for (const label of ["Cluster", "shop", "analytics", "restricted", "kube-system"]) {
      await expect(row(page, label), label).toBeVisible({ timeout: 20_000 });
    }
    await open(page, "shop", "Workloads", "Deployments");
    await row(page, "web").click();
    await expect(page.getByTestId("object-source-view")).toContainText("kind: Deployment", { timeout: 20_000 });
  });

  test("a pod's row menu runs Describe and Logs, each in a tab of its own", async ({ page }) => {
    await connectAs(page, "reader");
    await open(page, "shop", "Workloads", "Pods");
    for (const [action, statement] of [
      ["Describe", "kubectl describe pod/crasher -n shop"],
      ["Logs", "kubectl logs pod/crasher -n shop --tail=50"],
    ] as const) {
      const before = await gridText(page);
      await row(page, "crasher").hover();
      await row(page, "crasher").getByTestId("tree-row-menu-trigger").click();
      await page.getByRole("menuitem", { name: action }).click();
      await expectGridShows(page, READER_STATEMENT_FACTS[statement], before, action);
    }
  });

  test("a click on a pod's row runs its Logs for the last 50 lines, and a second click returns to that tab", async ({
    page,
  }) => {
    const statement = "kubectl logs pod/crasher -n shop --tail=50";
    await connectAs(page, "reader");
    await open(page, "shop", "Workloads", "Pods");
    const before = await gridText(page);
    await row(page, "crasher").click();
    const tab = page.getByRole("tab", { name: /Logs: crasher/ });
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await expectGridShows(page, READER_STATEMENT_FACTS[statement], before, "pod click");
    await expect.poll(() => queryText(page), { timeout: 20_000 }).toBe(statement);
    expect(
      stub.requests.some((request) => request.includes("/pods/crasher/log?") && request.includes("tailLines=50&")),
    ).toBe(true);
    await expect(page.getByTestId("object-source-view")).toHaveCount(0);

    await page.getByRole("tab", { name: /Query 1/ }).click();
    await row(page, "crasher").click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
    await expect(page.getByRole("tab", { name: /Logs: crasher/ })).toHaveCount(1);
  });

  test("every console command answers its grid", async ({ page }) => {
    await connectAs(page, "reader");
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    for (const statement of CONSOLE) {
      const before = await gridText(page);
      await runStatement(page, statement);
      await expectGridShows(page, READER_STATEMENT_FACTS[statement], before, statement);
      await expect(page.getByTestId("run-failure"), statement).toHaveCount(0);
    }
  });

  test("a Secret shows its name and no value, in the YAML view and in the console", async ({ page }) => {
    await connectAs(page, "reader");
    await open(page, "shop", "Config", "Secrets");
    await row(page, M.secretName).click();
    const source = page.getByTestId("object-source-view");
    await expect(source).toContainText(M.secretName, { timeout: 20_000 });
    // The YAML is a Monaco editor that renders only the lines in view, so the whole document is read from its model.
    await expect.poll(() => sourceText(page), { timeout: 20_000 }).toContain("type: Opaque");
    const yaml = await sourceText(page);
    expect(yaml).toContain(M.secretName);
    // The data map is removed whole, its key names with it: a key can be a secret too.
    expect(yaml).not.toContain(M.secretKey);
    for (const form of SECRET_FORMS) expect(yaml).not.toContain(form);
    expect(yaml).not.toContain(LAST_APPLIED);
    await page.getByRole("tab", { name: "Query 1" }).click();
    const statement = `kubectl get secret ${M.secretName} -n shop -o yaml`;
    const before = await gridText(page);
    await runStatement(page, statement);
    await expectGridShows(page, READER_STATEMENT_FACTS[statement], before, statement);
    for (const form of SECRET_FORMS) await expect(page.locator("body")).not.toContainText(form);
    await expect(page.locator("body")).not.toContainText(LAST_APPLIED);
  });

  test("the viewer sees Secrets locked, in Studio's own sentence", async ({ page }) => {
    await connectAs(page, "viewer");
    await open(page, "shop", "Config");
    await expect(row(page, "Secrets").getByTestId("tree-row-unavailable")).toHaveText(
      forbiddenSentence({ verb: "list", resource: "secrets", group: "", namespace: "shop" }),
      { timeout: 20_000 },
    );
  });

  test("a refused statement shows its sentence, and the stub receives no request for it", async ({ page }) => {
    await connectAs(page, "reader");
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    const before = await requestsSettled();
    await runStatement(page, "kubectl exec -it pod/x -- sh");
    await expect(
      page
        .getByText(
          "kubectl exec is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
        )
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    expect(await requestsSettled()).toBe(before);
  });

  test("an identity bound to shop alone sees Cluster and shop, and the console reads shop", async ({ page }) => {
    await connectAs(page, "shopOnly");
    await expect(row(page, "shop")).toBeVisible({ timeout: 20_000 });
    for (const label of ["analytics", "restricted", "kube-system"])
      await expect(row(page, label), label).toHaveCount(0);
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    const before = await gridText(page);
    await runStatement(page, "kubectl get pods");
    await expectGridShows(page, { cell: "crasher" }, before, "kubectl get pods");
  });

  test("a kubeconfig that cannot be read shows the parse sentence, and its token appears nowhere", async ({ page }) => {
    const pasted = "e2e-pasted-token-never-shown";
    const messages: string[] = [];
    page.on("console", (message) => messages.push(message.text()));
    const dialog = await signInAndOpenDialog(page);
    await dialog.getByTestId("connection-import-open").click();
    const text = kubeconfig(pasted, "e2e-broken").replace(
      `      token: ${pasted}\n`,
      `      token: ${pasted}\n      token: ${pasted}\n`,
    );
    expect(text.split(pasted)).toHaveLength(3);
    await dialog.getByTestId("connection-import-text").fill(text);
    await dialog.getByTestId("connection-import-read").click();
    await expect(dialog.getByText("The kubeconfig could not be read: DUPLICATE_KEY at line 13, column 7.")).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(dialog.getByTestId("connection-import-context")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(pasted);
    await expect(dialog.getByTestId("connection-import-text")).toHaveValue("");
    expect(messages.filter((message) => message.includes(pasted))).toEqual([]);
  });

  test("every read the browser made was one the capture holds", () => {
    expect(stub.unrecorded).toEqual([]);
  });
});
