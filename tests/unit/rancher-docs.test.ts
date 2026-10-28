/**
 * Facts in the Rancher documents that went stale once already, or that a reader acts on.
 *
 * `deploy/rancher/CATALOG_LISTING.md` called rancher/partner-charts#1168 open for weeks
 * after it merged on 2026-09-23, so the state of that pull request is pinned here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

describe("deploy/rancher/CATALOG_LISTING.md", () => {
  const listing = read("deploy/rancher/CATALOG_LISTING.md");

  test("never calls rancher/partner-charts#1168 open, which merged on 2026-09-23", () => {
    expect(listing).not.toMatch(/#1168 is OPEN/i);
    expect(listing).not.toMatch(/submitted on 2026-09-09 is still open/);
    expect(listing).toMatch(/#1168[^\n]*merged on 2026-09-23/);
  });

  test("makes no claim about the Rancher extension, which is not listed", () => {
    expect(listing).not.toMatch(/partner-extensions/);
    expect(listing).not.toMatch(/UI extension/i);
  });
});
