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

/** Read once as text too: two of the rules below are about characters the
 *  parser would happily hand back, and about a key whose absence a typed read
 *  cannot see. */
const RAW = fs.readFileSync(TEMPLATE, "utf8");

const template = parse(RAW) as {
  caproverOneClickApp: {
    description?: string;
    instructions?: { start?: string; end?: string };
    variables?: Array<{ id: string; defaultValue?: string; description?: string }>;
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

  test("the version moves in both places at once", () => {
    // README: "The version appears twice in that file, the defaultValue of
    // $$cap_version and the example inside its description, and both must move
    // together." Nothing checked that, so an upgrade could leave the example
    // naming the release before it.
    const version = template.caproverOneClickApp.variables?.find((variable) => variable.id === "$$cap_version");
    const pinned = version?.defaultValue ?? "";
    expect(pinned).toBeTruthy();
    expect(version?.description ?? "").toContain(`Example - ${pinned}.`);
  });

  test("the plain-HTTP cookie override is present", () => {
    // CapRover serves over http until the operator enables HTTPS, and the app
    // marks its auth cookie Secure on a non-loopback host, so the browser drops
    // it and login loops with no error. The override lived only in the
    // published catalog for a while, which meant the next sync from this folder
    // would have removed it silently. Measured 2026-09-20 and again 2026-09-28.
    expect(RAW).toContain("AUTH_COOKIE_SECURE: 'false'");
  });

  test("nothing in this template carries a dash or an icon we strip downstream", () => {
    // Three of the four revisions published to caprover/one-click-apps carried a
    // rocket and a warning icon; the fourth, 2026-09-22, was the first cleaned by
    // hand. Leaving them here means doing that by hand on every submission, and
    // three times out of four nobody did. The first version of this assertion
    // named four code points and missed the very rocket that was in the file,
    // which is the argument for asking Unicode what a pictograph is.
    expect(RAW).not.toMatch(/[\u2013\u2014]/);
    expect(RAW).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test("the pinned tag does not fall behind the release", () => {
    // The gap issue #268 describes: a release bumps package.json while this
    // file stays where it was, and distribution:check does not notice because
    // its pin measures the published catalog rather than this copy. The two
    // assertions above only check this file against itself.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as { version?: string };
    const version = template.caproverOneClickApp.variables?.find((variable) => variable.id === "$$cap_version");
    expect(version?.defaultValue).toBe(pkg.version);
  });
});
