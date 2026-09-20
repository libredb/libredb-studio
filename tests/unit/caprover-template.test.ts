/**
 * Unit tests for the CapRover one-click template (deploy/caprover/libredb-studio.yml).
 *
 * This file is the source a submission to caprover/one-click-apps is cut from, and
 * that repository validates what it receives: scripts/validate_apps.js rejects an app
 * whose `description` runs past 200 characters, and its CI runs that validator on every
 * pull request. Nothing here measured it, so the description grew to 293 characters
 * while the engine list was kept exhaustive for the catalog-copy gate, and the bump to
 * 0.16.1 was the pull request that would have failed.
 *
 * The two rules pull in opposite directions, which is why both are asserted here: the
 * copy gate in tests/unit/lib/catalog-copy-engine-count.test.ts requires the numeral to
 * match EXTERNAL_DATABASE_TYPES and an exhaustive list to name every engine, and this
 * limit is what makes the abridged form ("and more") the only one that fits.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

/** The limit scripts/validate_apps.js enforces in caprover/one-click-apps. */
const DESCRIPTION_LIMIT = 200;

const TEMPLATE = path.join(__dirname, "../../deploy/caprover/libredb-studio.yml");

const template = parse(fs.readFileSync(TEMPLATE, "utf8")) as {
  caproverOneClickApp: {
    description?: string;
    instructions?: { start?: string; end?: string };
    variables?: Array<{ id: string; defaultValue?: string }>;
  };
};

describe("the CapRover template passes what caprover/one-click-apps validates", () => {
  test("the description fits the 200-character limit", () => {
    const description = template.caproverOneClickApp.description ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  test("both instruction blocks are present", () => {
    expect(template.caproverOneClickApp.instructions?.start).toBeTruthy();
    expect(template.caproverOneClickApp.instructions?.end).toBeTruthy();
  });

  test("the version variable offers a pinned tag, never latest", () => {
    const version = template.caproverOneClickApp.variables?.find((variable) => variable.id === "$$cap_version");
    expect(version?.defaultValue).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
