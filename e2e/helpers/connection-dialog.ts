/**
 * Opens the connection dialog the way a reader does: through the sidebar header's `New connection` button, found by
 * its accessible name (its `aria-label` in src/components/sidebar/Sidebar.tsx).
 *
 * Never by its position. The header draws `Read the objects again` and `Show ERD Diagram` before it once the active
 * connection's metadata has loaded, and the Sample (LibreDB) connection is active at sign-in, so which button comes
 * first depends on whether that read landed before the click. tests/unit/e2e-connection-dialog.test.ts holds every
 * spec to this helper.
 */
import type { Page } from "@playwright/test";

export const NEW_CONNECTION_LABEL = "New connection";

export async function openConnectionDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: NEW_CONNECTION_LABEL, exact: true }).click();
}
