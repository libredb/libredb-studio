import { test, expect } from "@playwright/test";

// Regression test for #94: the flex chain around Monaco lacked min-height:0,
// so after a viewport shrink the editor kept its stale larger height,
// overflowed the panel clip, and the tail of the document could never be
// scrolled into view (the scrollbar hit bottom while lines stayed hidden).

type MonacoEditorHandle = {
  setValue: (value: string) => void;
  setScrollTop: (top: number) => void;
  getScrollHeight: () => number;
};

type MonacoWindow = {
  monaco?: { editor: { getEditors: () => MonacoEditorHandle[] } };
};

test.describe("Editor layout", () => {
  test("editor shrinks with the viewport and stays inside its panel", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => ((window as unknown as MonacoWindow).monaco?.editor.getEditors().length ?? 0) > 0);

    // A document long enough to need vertical scrolling at any panel size
    await page.evaluate(() => {
      const lines = [];
      for (let i = 1; i <= 60; i++) lines.push(`SELECT ${i} AS col FROM users WHERE id = ${i};`);
      const monaco = (window as unknown as MonacoWindow).monaco;
      if (!monaco) throw new Error("monaco not loaded");
      monaco.editor.getEditors()[0].setValue(lines.join("\n"));
    });

    // Lay the editor out large first, then shrink: growth always relayouts,
    // it is the shrink path that used to deadlock.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 950, height: 600 });

    // Scrolled to the very end, the editor's bottom edge must sit inside its
    // clipping panel; any positive overhang means hidden, unreachable lines.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const monaco = (window as unknown as MonacoWindow).monaco;
            if (!monaco) throw new Error("monaco not loaded");
            const ed = monaco.editor.getEditors()[0];
            ed.setScrollTop(ed.getScrollHeight());
            const monacoEl = document.querySelector(".monaco-editor");
            const panel = monacoEl?.closest('[data-slot="resizable-panel"]');
            if (!monacoEl || !panel) throw new Error("editor or panel not found");
            return Math.round(monacoEl.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom);
          }),
        { timeout: 5000 },
      )
      .toBeLessThanOrEqual(1);
  });
});
