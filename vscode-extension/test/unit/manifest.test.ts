import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOOR_NODE, STABLE_RUNTIME } from "../vscode-floor";

const root = join(__dirname, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = read("package.json");
const nls = read("package.nls.json");
const versions = read("test/vscode-versions.json");
const rootManifest = read("../package.json");

const exact = /^\d+\.\d+\.\d+$/;
const triple = (version: string): number[] => version.split(".").map(Number);
const atLeast = (a: number[], b: number[]): boolean =>
  a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));

describe("the manifest", () => {
  it("asks for VS Code ^1.123.0, the minor of the pinned floor build", () => {
    assert.equal(manifest.engines.vscode, "^1.123.0");
    assert.deepEqual(versions, { floor: "1.123.2", stable: "1.142.0" });
    assert.equal(versions.floor.split(".").slice(0, 2).join("."), "1.123");
  });

  it("rests on a floor whose Node satisfies the root's engines.node", () => {
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(rootManifest.engines.node);
    assert.ok(floor, `engines.node is ${rootManifest.engines.node}, not a >= floor this test can read`);
    assert.ok(atLeast(triple(FLOOR_NODE), triple(floor[1])), `${FLOOR_NODE} is below ${floor[1]}`);
  });

  it("pins the stable build that STABLE_RUNTIME in test/vscode-floor.ts describes, whose Node meets engines.node", () => {
    // The integration leg's vscode run checks the child's runtime against STABLE_RUNTIME, so a bump of the pin
    // updates both.
    assert.equal(versions.stable, "1.142.0");
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(rootManifest.engines.node);
    assert.ok(floor, `engines.node is ${rootManifest.engines.node}, not a >= floor this test can read`);
    assert.ok(atLeast(triple(STABLE_RUNTIME.node), triple(floor[1])), `${STABLE_RUNTIME.node} is below ${floor[1]}`);
  });

  it("types against @types/vscode 1.120.0, no newer than the floor", () => {
    assert.equal(manifest.devDependencies["@types/vscode"], "1.120.0");
    assert.ok(atLeast(triple(versions.floor), triple(manifest.devDependencies["@types/vscode"])));
  });

  it("declares no activationEvents, extensionKind or browser entry, and depends on vscode.sql", () => {
    for (const key of ["activationEvents", "extensionKind", "browser"]) assert.equal(key in manifest, false, key);
    assert.deepEqual(manifest.extensionDependencies, ["vscode.sql"]);
  });

  it("has a major.minor.patch version and pins every dev tool exactly", () => {
    assert.match(manifest.version, exact);
    assert.deepEqual(
      Object.entries(manifest.devDependencies).filter(([, v]) => !exact.test(String(v))),
      [],
    );
  });

  it("pins vscode-jsonrpc exactly, as the bundles' one runtime package", () => {
    assert.deepEqual(manifest.dependencies, { "vscode-jsonrpc": "9.0.3" });
  });

  it("contributes libredb.showLog in category LibreDB", () => {
    assert.deepEqual(manifest.contributes, {
      commands: [{ command: "libredb.showLog", title: "Show Log", category: "LibreDB" }],
    });
  });

  it("is limited in untrusted workspaces, with no restricted configuration", () => {
    assert.deepEqual(manifest.capabilities, {
      untrustedWorkspaces: { supported: "limited", description: "%untrustedWorkspaces.description%" },
    });
    assert.deepEqual(nls, {
      "untrustedWorkspaces.description":
        "In Restricted Mode, LibreDB opens every connection with external file access denied.",
    });
  });

  it("pins @happy-dom/global-registrator to the major of the root's happy-dom", () => {
    const rootHappyDom = /"happy-dom@(\d+)\.\d+\.\d+"/.exec(readFileSync(join(root, "../bun.lock"), "utf8"));
    assert.ok(rootHappyDom, "the root bun.lock resolves no happy-dom");
    assert.equal(manifest.devDependencies["@happy-dom/global-registrator"].split(".")[0], rootHappyDom[1]);
  });

  it("is private, MIT, and loads dist/extension.js", () => {
    assert.equal(manifest.private, true);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.main, "./dist/extension.js");
  });
});
