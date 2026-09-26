import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The E2E and Channel E2E jobs run inside Playwright's own image so `playwright install` never
// touches apt (see the comment above the e2e job in ci.yml). The image carries the browsers of
// one Playwright release; when @playwright/test moves and the tag does not, every run downloads
// the browsers again into PLAYWRIGHT_BROWSERS_PATH. The job still passes, so nothing noticed
// that #623 moved @playwright/test to 1.63.0 while both tags stayed at v1.62.1. Dependabot's
// docker ecosystem reads the Dockerfiles only, not a workflow's `container.image`, so this test
// is what keeps the two in step: a bump of either fails here until the other follows.

const ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = join(ROOT, ".github/workflows");
const IMAGE = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z0-9-]+)?/g;

function lockedPlaywrightVersion(): string {
  const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
  const match = lock.match(/"@playwright\/test": \["@playwright\/test@(\d+\.\d+\.\d+)"/);
  if (!match) throw new Error("bun.lock resolves no @playwright/test");
  return match[1];
}

function workflowImages(): { file: string; line: number; version: string }[] {
  const images: { file: string; line: number; version: string }[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
    readFileSync(join(WORKFLOWS, file), "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const match of text.matchAll(IMAGE)) images.push({ file, line: index + 1, version: match[1] });
      });
  }
  return images;
}

describe("the Playwright image in the workflows tracks the locked @playwright/test", () => {
  test("the workflows name at least one Playwright image, so the check below cannot pass empty", () => {
    expect(workflowImages().length).toBeGreaterThan(0);
  });

  test("every Playwright image tag is the version bun.lock resolves", () => {
    const locked = lockedPlaywrightVersion();
    const drifted = workflowImages()
      .filter((image) => image.version !== locked)
      .map((image) => `${image.file}:${image.line} uses v${image.version}, bun.lock resolves ${locked}`);
    expect(drifted).toEqual([]);
  });
});
