import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NEW_CONNECTION_LABEL } from "../../e2e/helpers/connection-dialog";

// The sidebar header draws `Read the objects again` and `Show ERD Diagram` before `New connection` once the active
// connection's metadata has loaded, and the Sample (LibreDB) connection is active at sign-in. A spec that climbed
// from the "LibreDB Studio" text to that header and clicked its first button opened the dialog only when the click
// beat the metadata read; otherwise it pressed another control and timed out waiting for an engine button in a dialog
// that never opened (measured on 2026-10-17 with e2e/opcua-provider.spec.ts: 3 of 28 tests under load). So every spec
// opens the dialog through openConnectionDialog, which finds the button by its accessible name, and no spec picks a
// header button by its position.

const ROOT = path.resolve(import.meta.dir, "../..");
const HELPER = "e2e/helpers/connection-dialog.ts";
/** `page.locator("text=LibreDB Studio").locator("..")`: the first step of the climb to the header's buttons. */
const HEADER_CLIMB = /locator\(\s*["'`]text=LibreDB Studio["'`]\s*\)\s*\.locator\(\s*["'`]\.\.["'`]\s*\)/;

const e2eSources = [...new Bun.Glob("e2e/**/*.ts").scanSync(ROOT)]
  .map((file) => file.split(path.sep).join("/"))
  .sort()
  .map((file) => ({ file, source: readFileSync(path.join(ROOT, file), "utf8") }));

describe("specs open the connection dialog by the button's name, never by its position in the sidebar header", () => {
  test("the E2E sources were found, so the checks below cannot pass empty", () => {
    expect(e2eSources.map(({ file }) => file)).toContain(HELPER);
    expect(e2eSources.length).toBeGreaterThan(10);
  });

  test("the helper's label is the accessible name the sidebar header gives the button", () => {
    const sidebar = readFileSync(path.join(ROOT, "src/components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toContain(`aria-label="${NEW_CONNECTION_LABEL}"`);
  });

  test("no E2E source climbs from the LibreDB Studio heading to the header's buttons", () => {
    const climbs = e2eSources.flatMap(({ file, source }) =>
      source
        .split("\n")
        .map((line, index) => ({ at: `${file}:${index + 1}`, line }))
        .filter(({ line }) => HEADER_CLIMB.test(line))
        .map(({ at }) => at),
    );
    expect(climbs).toEqual([]);
  });

  test("only the helper names the button, so every spec opens the dialog the same way", () => {
    const inline = e2eSources
      .filter(({ file }) => file !== HELPER)
      .filter(({ source }) => source.includes(`"${NEW_CONNECTION_LABEL}"`))
      .map(({ file }) => file);
    expect(inline).toEqual([]);
  });
});
