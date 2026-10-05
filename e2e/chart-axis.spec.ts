/**
 * Rotated chart labels used to run into the legend, and the first one was
 * clipped at the left edge of the SVG (#1130). happy-dom has no layout, so
 * the overlap is proved here, against the real recharts build.
 */
import { expect, test, type Page } from "@playwright/test";

test.describe("Chart axis labels", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("timestamp ticks sit above the legend and inside the chart", async ({ page }) => {
    await loginAsAdmin(page);

    const sample = page.locator("text=Sample (Employees)").first();
    await expect(sample).toBeVisible({ timeout: 45_000 });
    await sample.click();

    await runQuery(
      page,
      [
        "SELECT '2026-09-26T22:34:00.000Z' AS ts, 1 AS n",
        "UNION ALL SELECT '2026-09-26T22:36:00.000Z', 2",
        "UNION ALL SELECT '2026-09-26T22:38:00.000Z', 3",
        "UNION ALL SELECT '2026-09-26T22:40:00.000Z', 4",
      ].join(" "),
    );
    await expect(page.locator("text=2026-09-26T22:34:00.000Z").first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Charts" }).click();
    await page.getByRole("button", { name: "Line", exact: true }).click();

    // Recharts 3 draws tick text in a z-index layer, so it is not a descendant of
    // `.recharts-xAxis`. The x-axis labels are the group `recharts-xAxis-tick-labels`.
    const tick = page.locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value").first();
    const legend = page.locator(".recharts-legend-wrapper");
    await expect(tick).toBeVisible({ timeout: 15_000 });
    await expect(legend).toBeVisible();

    const layout = await page.evaluate(() => {
      const labelGroup = document.querySelector(".recharts-xAxis-tick-labels");
      const svg = labelGroup instanceof SVGElement ? labelGroup.ownerSVGElement : null;
      const wrapper = labelGroup?.closest(".recharts-wrapper") ?? null;
      const legendEl = wrapper?.querySelector(".recharts-legend-wrapper") ?? null;
      const ticks = [...document.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value")];
      if (!svg || !wrapper || !legendEl || ticks.length === 0) {
        return { ok: false, reason: "missing chart pieces", ticks: ticks.length };
      }
      const svgBox = svg.getBoundingClientRect();
      const legendBox = legendEl.getBoundingClientRect();
      // The legend sits `margin.bottom` above the chart's edge, and the space
      // below it draws nothing, so it must not take the plot's height.
      const gapBelowLegend = wrapper.getBoundingClientRect().bottom - legendBox.bottom;
      const boxes = ticks
        .map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, text: node.textContent };
        })
        .sort((a, b) => a.left - b.left);
      const first = boxes[0];
      const aboveLegend = boxes.every((box) => box.bottom <= legendBox.top + 1);
      const insideSvg = first.left >= svgBox.left - 1;
      const tightBelowLegend = gapBelowLegend <= 16;
      return {
        ok: aboveLegend && insideSvg && tightBelowLegend,
        aboveLegend,
        insideSvg,
        gapBelowLegend,
        first,
        svgLeft: svgBox.left,
        legendTop: legendBox.top,
        boxes,
      };
    });

    expect(layout.ok, JSON.stringify(layout)).toBe(true);

    // The tick is shortened. The tooltip still shows the value the query returned.
    await page.locator(".recharts-line-dot").first().hover();
    await expect(page.locator(".recharts-tooltip-wrapper")).toContainText("2026-09-26T22:");
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  // The login page renders more than one field of each type. A bare type
  // selector is a strict-mode violation, same as e2e/agent-models.spec.ts.
  await page.locator('input[type="email"]').first().fill("admin@libredb.org");
  await page.locator('input[type="password"]').first().fill("test-admin");
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/admin(?:\/.*)?$/);
  await page.goto("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 15_000 });
}

async function runQuery(page: Page, sql: string): Promise<void> {
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () =>
      ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length ??
        0) > 0,
  );
  await page.evaluate((query) => {
    const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
      .monaco;
    if (!monaco) throw new Error("monaco global not found");
    monaco.editor.getEditors()[0].setValue(query);
  }, sql);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
}
