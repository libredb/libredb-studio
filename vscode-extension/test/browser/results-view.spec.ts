// The Results webview in Chromium, under the CSP renderResultsHtml writes (part 4 "Tests", the browser leg).
// The bundle is dist/webview, as `npm run build` leaves it; the harness serves it with no server and a fake host.
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { HostToWebview, ThemeKind } from "../../src/results-protocol";
import {
  EMPTY_AND_NOTICES,
  FAILURES,
  LOAD_MORE_ON_POSTGRES,
  MONGODB_DOCUMENTS,
  POSTGRES_GRID,
  RUN_A,
  RUN_B,
} from "../fixtures/results-sequences";
import { COPY_FAILED_SENTENCE } from "../../src/webview/notices";
import { openResultsView, type ResultsPage } from "./harness";

/** The bounds the Review Focus 2 case holds the 10 MB cell to, from a local measurement with a margin (decision 12). */
const LARGE_CELL_RENDER_MS = 5_000;
const FRAME_MS = 250;
const SORT_MS = 1_000;

const init = (theme: ThemeKind = "dark"): HostToWebview => ({ v: 1, type: "init", theme });

async function postAll(view: ResultsPage, messages: HostToWebview[]): Promise<void> {
  for (const message of messages) await view.post(message);
}

/** The stats strip's row count, "N rows". */
const rowCount = (page: Page): Locator => page.getByText(/^\d+ rows/);
const desktopGrid = (page: Page): Locator => page.locator("[data-desktop-grid]");
const gridCell = (page: Page, text: string): Locator =>
  desktopGrid(page).getByRole("gridcell").filter({ hasText: text }).first();

/** Posts `message` in the page and returns what the webview posted in answer, after `settle` holds. */
async function postedAfter(view: ResultsPage, act: () => Promise<void>): Promise<unknown[]> {
  const before = (await view.posted()).length;
  await act();
  return (await view.posted()).slice(before);
}

/** Two requestAnimationFrame round trips, each timed in the page. */
async function frameTimes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      times.push(performance.now() - start);
    }
    return times;
  });
}

function annotate(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`${type}: ${description}`);
}

test("criterion 4: a result, the cell menu, the row detail, a column filter and a page raise no CSP violation", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await expect(rowCount(page)).toHaveText(/^2 rows/);

  await gridCell(page, "ada@example.com").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy Cell" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Copy Cell" })).toHaveCount(0);

  await desktopGrid(page).getByRole("button", { name: "Show row 1 field by field" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await desktopGrid(page).getByRole("columnheader", { name: /^name/ }).getByTitle("Filter column").click();
  const filter = page.getByPlaceholder("Filter name...");
  await filter.fill("1");
  await filter.fill("");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "load 2 more" }).click();
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(2));
  await expect(rowCount(page)).toHaveText(/^4 rows/);
  expect(await view.violations()).toEqual([]);
});

test("criterion 5: the theme kind on <html>, a live theme change, and the bridge's colours over the host's defaults", async ({
  page,
}) => {
  const expected: Record<ThemeKind, { dark: boolean; contrast: string | null }> = {
    light: { dark: false, contrast: null },
    dark: { dark: true, contrast: null },
    highContrast: { dark: true, contrast: "high" },
    highContrastLight: { dark: false, contrast: "high" },
  };
  for (const [theme, want] of Object.entries(expected) as [ThemeKind, (typeof expected)[ThemeKind]][]) {
    const view = await openResultsView(page);
    await view.post(init(theme));
    const html = page.locator("html");
    if (want.dark) await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    if (want.contrast === null) await expect(html).not.toHaveAttribute("data-libredb-contrast");
    else await expect(html).toHaveAttribute("data-libredb-contrast", want.contrast);
  }

  const view = await openResultsView(page);
  await view.post(init("light"));
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = "kept";
  });
  await view.post({ v: 1, type: "theme", theme: "dark" });
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe("kept");

  const grid = desktopGrid(page);
  await expect(grid.locator("..")).toHaveCSS("background-color", "rgb(10, 20, 30)");
  await expect(grid.getByRole("row").first()).toHaveCSS("background-color", "rgb(40, 50, 60)");
  expect(await page.evaluate(() => getComputedStyle(document.body).padding)).toBe("0px");
  expect(
    await page.evaluate(() =>
      [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/host-defaults.css") ?? false),
    ),
  ).toBe(true);

  await view.post({ v: 1, type: "theme", theme: "highContrast" });
  await expect(gridCell(page, "Ada")).toHaveCSS("border-bottom-color", "rgb(255, 0, 255)");
  expect(await view.violations()).toEqual([]);
});

test("criterion 16: under 768 px the grid shows its cards and the page does not scroll sideways", async ({ page }) => {
  const view = await openResultsView(page, { width: 600 });
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await expect(page.getByRole("button").filter({ hasText: "ada@example.com" }).first()).toBeVisible();
  await expect(desktopGrid(page)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});

test("Review Focus 2: a 10 MB cell renders, the grid stays responsive, and the next page is not lost", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  const start = Date.now();
  await page.evaluate(
    ({ runId, grid, bytes }) => {
      window.postMessage({ v: 1, type: "runStarted", runId, statement: "select id, body from big", startedAt: 1 }, "*");
      window.postMessage(
        {
          v: 1,
          type: "runSucceeded",
          runId,
          page: {
            rows: [{ id: 1, body: "x".repeat(bytes) }],
            fields: ["id", "body"],
            rowCount: 1,
            executionTime: 40,
            pagination: { limit: 1, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
          },
          grid,
        },
        "*",
      );
    },
    { runId: RUN_A, grid: POSTGRES_GRID, bytes: 10 * 1024 * 1024 },
  );
  await expect(rowCount(page)).toHaveText(/^1 rows/, { timeout: LARGE_CELL_RENDER_MS });
  await expect(desktopGrid(page).getByRole("gridcell").filter({ hasText: /^1$/ })).toHaveCount(1);
  const renderMs = Date.now() - start;
  annotate("10 MB cell render ms", String(renderMs));

  const frames = await frameTimes(page);
  annotate("frame ms after the 10 MB cell", frames.map((ms) => ms.toFixed(1)).join(", "));
  for (const ms of frames) expect(ms).toBeLessThan(FRAME_MS);

  const header = desktopGrid(page).getByRole("columnheader", { name: /^id/ });
  await header.getByTitle("Sort").click();
  await expect(header.getByTitle("Sort")).toHaveAttribute("aria-label", /sorted ascending/, { timeout: SORT_MS });

  await view.post({ v: 1, type: "pageStarted", runId: RUN_A });
  await view.post({
    v: 1,
    type: "pageAppended",
    runId: RUN_A,
    page: {
      rows: [{ id: 2, body: "y" }],
      fields: ["id", "body"],
      rowCount: 1,
      executionTime: 3,
      pagination: { limit: 1, offset: 1, hasMore: false, totalReturned: 1, wasLimited: true },
    },
  });
  await expect(rowCount(page)).toHaveText(/^2 rows/);
});

/** Posts runStarted and a runSucceeded whose one page holds `rows` rows { n, text: "row n" }, built in the page. */
async function postGeneratedRun(page: Page, runId: string, rows: number): Promise<void> {
  await page.evaluate(
    ({ runId, grid, rows }) => {
      window.postMessage({ v: 1, type: "runStarted", runId, statement: "select n, text from t", startedAt: 1 }, "*");
      window.postMessage(
        {
          v: 1,
          type: "runSucceeded",
          runId,
          page: {
            rows: Array.from({ length: rows }, (_, i) => ({ n: i + 1, text: `row ${i + 1}` })),
            fields: ["n", "text"],
            rowCount: rows,
            executionTime: 20,
            pagination: { limit: rows, offset: 0, hasMore: false, totalReturned: rows, wasLimited: false },
          },
          grid,
        },
        "*",
      );
    },
    { runId, grid: POSTGRES_GRID, rows },
  );
}

test("U12: a 500-row and a 10,000-row page, each timed from postMessage to the strip", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());
  for (const [index, rows] of [500, 10_000].entries()) {
    const start = Date.now();
    await postGeneratedRun(page, index === 0 ? RUN_A : RUN_B, rows);
    await expect(rowCount(page)).toHaveText(new RegExp(`^${rows} rows`));
    annotate(`${rows}-row round trip ms`, String(Date.now() - start));
  }
});

test("the grid fills the view and scrolls itself: its rows are virtualized, its header stays, its scroll is saved", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postGeneratedRun(page, RUN_B, 10_000);
  await expect(rowCount(page)).toHaveText(/^10000 rows/);
  const grid = desktopGrid(page);
  const measure = () =>
    grid.evaluate((element) => {
      const header = element.querySelector('[role="row"]') as HTMLElement;
      return {
        gridHeight: element.clientHeight,
        gridBottom: element.getBoundingClientRect().bottom,
        rendered: element.querySelectorAll('[role="row"]').length,
        documentHeight: document.documentElement.scrollHeight,
        headerOffset: header.getBoundingClientRect().top - element.getBoundingClientRect().top,
      };
    });
  const before = await measure();
  expect(before.gridHeight).toBeGreaterThan(0);
  expect(before.gridBottom).toBeLessThanOrEqual(800);
  expect(before.documentHeight).toBeLessThanOrEqual(800);
  expect(before.rendered).toBeLessThan(100);

  await grid.evaluate((element) => {
    element.scrollTop = 2_000;
  });
  await expect
    .poll(() => view.state())
    .toEqual({ v: 1, maskingEnabled: false, scroll: { runId: RUN_B, top: 2_000, left: 0 } });
  const after = await measure();
  expect(after.headerOffset).toBe(0);
  expect(after.rendered).toBeLessThan(100);

  // A notice line above the grid takes its height from the grid's, not from the page's.
  await view.post({ v: 1, type: "pageFailed", runId: RUN_B, failure: { kind: "error", message: "timeout" } });
  await expect(page.getByText("Load More Error")).toBeVisible();
  const withNotice = await measure();
  expect(withNotice.gridBottom).toBeLessThanOrEqual(800);
  expect(withNotice.documentHeight).toBeLessThanOrEqual(800);
});

test("a failure taller than the view scrolls the page and keeps its first line in reach", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());
  await view.post({ v: 1, type: "runStarted", runId: RUN_A, statement: "select 1", startedAt: 1 });
  await view.post({
    v: 1,
    type: "runFailed",
    runId: RUN_A,
    failure: {
      kind: "error",
      message: "first line",
      detail: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
    },
  });
  const title = page.getByText("The query failed.");
  await expect(title).toBeVisible();
  expect(await title.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
});

test("criterion 8: Load More on PostgreSQL, from the recorded sequence", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await expect(rowCount(page)).toHaveText(/^2 rows/);
  await expect(page.getByText(/^12ms/)).toBeVisible();
  const more = page.getByRole("button", { name: "load 2 more" });
  const answer = await postedAfter(view, () => more.click());
  expect(answer).toEqual([{ v: 1, type: "loadMore", runId: RUN_A }]);
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(2));
  await expect(rowCount(page)).toHaveText(/^4 rows/);
  await expect(page.getByRole("button", { name: /load \d+ more/ })).toHaveCount(0);
});

test("criterion 9: each failure, from the recorded sequences", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());

  await postAll(view, FAILURES.pageFailed);
  await expect(page.getByText("Load More Error")).toBeVisible();
  await expect(page.getByText("canceling statement due to statement timeout")).toBeVisible();
  await expect(rowCount(page)).toHaveText(/^2 rows/);

  await postAll(view, FAILURES.runFailed);
  await expect(page.getByText("The query failed.")).toBeVisible();
  await expect(page.getByText('relation "nope" does not exist')).toBeVisible();

  await postAll(view, FAILURES.cancelled);
  await expect(page.getByText("Query Cancelled")).toBeVisible();

  await postAll(view, FAILURES.backendExited);
  await expect(page.getByText(/exit code none, signal SIGKILL/)).toBeVisible();
  expect(await view.violations()).toEqual([]);
});

test("criterion 10: an update count, the rolled-back notice and several result sets, from the recorded sequences", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, EMPTY_AND_NOTICES.update3);
  await expect(page.getByText("3 rows affected")).toBeVisible();
  await postAll(view, EMPTY_AND_NOTICES.loneBegin);
  await expect(page.getByText(/^Transaction rolled back\..*Add COMMIT to keep them\.$/)).toBeVisible();
  await postAll(view, EMPTY_AND_NOTICES.twoResultSets);
  await expect(page.getByText("This text produced 2 result sets; the first is shown.")).toBeVisible();
  await expect(rowCount(page)).toHaveText(/^1 rows/);
});

test("criterion 11: MongoDB documents, from the recorded page", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, MONGODB_DOCUMENTS);
  const grid = desktopGrid(page);
  for (const field of ["_id", "name", "address", "tags"]) {
    await expect(grid.getByRole("columnheader", { name: new RegExp(`^${field}`) })).toHaveCount(1);
  }
  await expect(gridCell(page, "65f1c0ffee0000000000abcd")).toBeVisible();
  await expect(gridCell(page, '{"city":"Izmir","zip":"35000"}')).toBeVisible();
  await expect(page.getByRole("button", { name: /load \d+ more/ })).toHaveCount(0);
  await grid.getByRole("button", { name: "Show row 1 field by field" }).click();
  const indented = JSON.stringify({ city: "Izmir", zip: "35000" }, null, 2);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate(
        (dialog, text) => [...dialog.querySelectorAll("*")].some((node) => node.textContent === text),
        indented,
      ),
  ).toBe(true);
});

test("criterion 12: Copy Cell, masked and not, and a copied cell range go through the host", async ({ page }) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));

  const copyCell = async (text: string): Promise<{ requestId: number; text: string }> => {
    const answer = await postedAfter(view, async () => {
      await gridCell(page, text).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Copy Cell" }).click();
    });
    const copy = answer.find((m) => (m as { type: string }).type === "copy") as { requestId: number; text: string };
    expect(copy).toBeDefined();
    return copy;
  };
  const settle = async (requestId: number): Promise<unknown[]> =>
    postedAfter(view, async () => {
      await view.post({ v: 1, type: "copied", requestId, ok: true });
      await expect.poll(async () => (await view.posted()).at(-1)).toMatchObject({ type: "notify" });
    });

  const plain = await copyCell("ada@example.com");
  expect(plain.text).toBe("ada@example.com");
  expect(await settle(plain.requestId)).toEqual([
    { v: 1, type: "notify", level: "info", message: "Cell copied to clipboard" },
  ]);

  await page.getByTitle("Mask sensitive data").click();
  const masked = desktopGrid(page).getByRole("row").nth(1).getByRole("gridcell").filter({ hasText: /\*/ }).first();
  const shown = (await masked.textContent()) ?? "";
  expect(shown).not.toContain("ada@example.com");
  const maskedCopy = await copyCell(shown);
  expect(maskedCopy.text).toBe(shown);
  await settle(maskedCopy.requestId);

  await page.getByTitle("Show sensitive data").click();
  await gridCell(page, "Ada").click();
  await gridCell(page, "Lin").click({ modifiers: ["Shift"] });
  const before = (await view.posted()).length;
  await page.keyboard.press("Control+C");
  // The grid's own notice goes out with the copy, before the host has answered.
  await expect
    .poll(async () => (await view.posted()).slice(before))
    .toEqual([
      { v: 1, type: "notify", level: "info", message: "2 cells copied to clipboard" },
      { v: 1, type: "copy", requestId: expect.any(Number), text: "Ada\nLin" },
    ]);
  const range = (await view.posted()).at(-1) as { requestId: number };
  // So a write the host could not make is said after it.
  await view.post({ v: 1, type: "copied", requestId: range.requestId, ok: false });
  await expect
    .poll(async () => (await view.posted()).slice(before + 2))
    .toEqual([{ v: 1, type: "notify", level: "error", message: COPY_FAILED_SENTENCE }]);
  expect(await view.violations()).toEqual([]);
});

test("criterion 12 in VS Code desktop: a cell range copied through execCommand, as the host page delivers Ctrl+C", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await gridCell(page, "Ada").click();
  await gridCell(page, "Lin").click({ modifiers: ["Shift"] });
  // The host page prevents the key press and answers it with execCommand("copy") in this document: with the grid
  // focused and no text selected, Chromium fires that copy event at the body, not at the grid.
  expect(
    await page.evaluate(() => [document.activeElement?.getAttribute("role"), document.getSelection()?.type]),
  ).toEqual(["grid", "None"]);
  const answer = await postedAfter(view, async () => {
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  });
  expect(answer).toEqual([
    { v: 1, type: "notify", level: "info", message: "2 cells copied to clipboard" },
    { v: 1, type: "copy", requestId: expect.any(Number), text: "Ada\nLin" },
  ]);
  expect(await view.violations()).toEqual([]);
});

test("the saved state holds the masking switch and the scroll only, and a reload shows the empty state", async ({
  page,
}) => {
  const view = await openResultsView(page);
  await view.post(init());
  await postAll(view, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await page.getByTitle("Mask sensitive data").click();
  expect(await view.state()).toEqual({ v: 1, maskingEnabled: true, scroll: null });

  const reloaded = await view.reload();
  await reloaded.post(init());
  await expect(page.getByText("No results yet. Run a query in a LibreDB editor to see its rows here.")).toBeVisible();
  await expect(desktopGrid(page)).toHaveCount(0);
  await postAll(reloaded, LOAD_MORE_ON_POSTGRES.slice(0, 2));
  await expect(page.getByTitle("Show sensitive data")).toBeVisible();
});
