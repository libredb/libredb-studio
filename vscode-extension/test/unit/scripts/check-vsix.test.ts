import assert from "node:assert/strict";
import { BUDGET, REQUIRED, vsixViolations } from "../../../scripts/check-vsix.mjs";

const KIB = 1024;
const REQUIRED_PATHS = [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/dist/backend.js",
  "extension/THIRD_PARTY_NOTICES.txt",
  "extension/LICENSE.txt",
];

interface Entry {
  path: string;
  size: number;
}

/** The entries vsce adds beside the required ones, as the packed 0.1.0 VSIX lists them. */
const VSCE_EXTRAS = [
  "extension.vsixmanifest",
  "[Content_Types].xml",
  "extension/readme.md",
  "extension/package.nls.json",
];

function passing(entries: Entry[] = [...REQUIRED_PATHS, ...VSCE_EXTRAS].map((path) => ({ path, size: KIB }))) {
  return { entries, vsixBytes: KIB * KIB, version: "0.1.0", preRelease: true };
}

/** The entries with the one at `path` resized so that all of them total `total` bytes. */
function totalling(entries: Entry[], path: string, total: number): Entry[] {
  const rest = entries.filter((entry) => entry.path !== path).reduce((sum, entry) => sum + entry.size, 0);
  return entries.map((entry) => (entry.path === path ? { path, size: total - rest } : entry));
}

const one = (vsix: ReturnType<typeof passing>) => {
  const violations = vsixViolations(vsix);
  assert.equal(violations.length, 1, violations.join("\n"));
  return violations[0];
};

describe("vsixViolations", () => {
  it("passes a VSIX holding the required entries within budget", () => {
    assert.deepEqual(vsixViolations(passing()), []);
  });

  it("requires the package manifest, both bundles, the notices and the licence", () => {
    assert.equal(REQUIRED.length, 5);
  });

  it("passes a VSIX, its unpacked content and its child bundle at exactly their budgets", () => {
    const base = passing();
    const atBackend = base.entries.map((entry) =>
      entry.path === "extension/dist/backend.js" ? { path: entry.path, size: BUDGET.backendBytes } : entry,
    );
    const entries = totalling(atBackend, "extension/readme.md", BUDGET.unpackedBytes);
    assert.deepEqual(vsixViolations({ ...base, vsixBytes: BUDGET.vsixBytes, entries }), []);
  });

  it("refuses a VSIX above its budget", () => {
    assert.match(one({ ...passing(), vsixBytes: BUDGET.vsixBytes + 1 }), /VSIX/);
  });

  it("refuses unpacked content above its budget", () => {
    const entries = totalling(passing().entries, "extension/readme.md", BUDGET.unpackedBytes + 1);
    assert.match(one(passing(entries)), /unpacked/);
  });

  it("refuses a child bundle above its budget", () => {
    const entries = passing().entries.map((entry) =>
      entry.path === "extension/dist/backend.js" ? { ...entry, size: BUDGET.backendBytes + 1 } : entry,
    );
    assert.match(one(passing(entries)), /extension\/dist\/backend\.js/);
  });

  for (const path of [
    "extension/dist/backend.js.map",
    "extension/node_modules/pg/package.json",
    "extension/src/host/extension.ts",
    "extension/test/unit/manifest.test.ts",
    "extension/build/Release/x.node",
  ]) {
    it(`refuses the entry ${path}`, () => {
      const entries = [...passing().entries, { path, size: KIB }];
      assert.ok(one(passing(entries)).startsWith(`${path}: `));
    });
  }

  for (const path of [
    "extension/out/test/e2e/smoke/skeleton.test.js",
    "extension/dist/backend.meta.json",
    "extension/.env.test",
    "extension/coverage/lcov.info",
    "extension/dist/backend.js.MAP",
    "extension/tsconfig.json",
    "extension/CHANGELOG.md",
  ]) {
    it(`refuses the entry ${path}, which is not on the allowlist`, () => {
      const entries = [...passing().entries, { path, size: KIB }];
      assert.equal(one(passing(entries)), `${path}: not on the VSIX allowlist.`);
    });
  }

  for (const path of REQUIRED_PATHS) {
    it(`refuses a VSIX without ${path}`, () => {
      const entries = passing().entries.filter((entry) => entry.path !== path);
      assert.ok(one(passing(entries)).includes("missing"));
    });
  }

  it("takes the licence as LICENSE or LICENSE.txt", () => {
    for (const licence of ["extension/LICENSE", "extension/LICENSE.txt"]) {
      const entries = passing().entries.map((entry) =>
        entry.path === "extension/LICENSE.txt" ? { ...entry, path: licence } : entry,
      );
      assert.deepEqual(vsixViolations(passing(entries)), []);
    }
  });

  it("refuses a pre-release flag that disagrees with the version's minor", () => {
    assert.match(one({ ...passing(), preRelease: false }), /0\.1\.0/);
    assert.match(one({ ...passing(), version: "0.2.0", preRelease: true }), /0\.2\.0/);
  });
});
