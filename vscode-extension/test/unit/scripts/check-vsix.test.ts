import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import { BUDGET, isDirectExecution, REQUIRED, vsixViolations } from "../../../scripts/check-vsix.mjs";

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

const EXTENSION_ROOT = join(__dirname, "..", "..", "..");
const CHECK_VSIX = join(EXTENSION_ROOT, "scripts", "check-vsix.mjs");

/** A zip of stored entries, as yauzl reads a VSIX: local headers, the central directory and its end record. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const PRE_RELEASE_MANIFEST =
  '<PackageManifest><Metadata><Identity Id="libredb-studio" Version="0.1.0" Publisher="libredb" />' +
  '<Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" /></Properties></Metadata></PackageManifest>';

describe("check-vsix.mjs as a program", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-check-vsix-"));
    // A junction on Windows, which needs no privilege; other platforms ignore the type.
    symlinkSync(EXTENSION_ROOT, join(dir, "linked"), "junction");
    const files = Object.fromEntries(REQUIRED_PATHS.map((path) => [path, "x"]));
    const vsix = { "extension.vsixmanifest": PRE_RELEASE_MANIFEST, ...files, "extension/.env": "TOKEN=x\n" };
    writeFileSync(join(dir, "dotenv.vsix"), storedZip(vsix));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the module node runs, by its real path, through a symlinked directory and with the link kept", () => {
    const moduleUrl = pathToFileURL(CHECK_VSIX).href;
    const linked = join(dir, "linked", "scripts", "check-vsix.mjs");
    assert.equal(isDirectExecution(CHECK_VSIX, moduleUrl), true);
    assert.equal(isDirectExecution(linked, moduleUrl), true);
    assert.equal(isDirectExecution(linked, pathToFileURL(linked).href), true);
  });

  it("names no other file, a missing one or none", () => {
    const moduleUrl = pathToFileURL(CHECK_VSIX).href;
    assert.equal(isDirectExecution(join(EXTENSION_ROOT, "scripts", "package.mjs"), moduleUrl), false);
    assert.equal(isDirectExecution(join(dir, "missing.mjs"), moduleUrl), false);
    assert.equal(isDirectExecution(undefined, moduleUrl), false);
  });

  for (const [how, scripts] of [
    ["its real path", () => join(EXTENSION_ROOT, "scripts")],
    ["a symlinked directory", () => join(dir, "linked", "scripts")],
  ] as const) {
    it(`refuses an entry off the allowlist when run through ${how}`, () => {
      const run = spawnSync(process.execPath, [join(scripts(), "check-vsix.mjs"), join(dir, "dotenv.vsix")], {
        encoding: "utf8",
      });
      assert.equal(run.stderr, "extension/.env: not on the VSIX allowlist.\n");
      assert.equal(run.status, 1);
    });
  }
});
