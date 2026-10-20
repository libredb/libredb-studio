// The e2e leg's @vscode/test-cli configuration (part 5, "Tests"): one configuration per pinned VS Code build,
// running the esbuild-bundled test files in out/ against the production dist/.
import versions from "./test/vscode-versions.json" with { type: "json" };

const subset = process.env.LIBREDB_E2E_SUBSET;
if (subset !== undefined && subset !== "smoke") {
  throw new Error(`LIBREDB_E2E_SUBSET is "${subset}"; set it to smoke or leave it unset.`);
}
const files = subset === "smoke" ? "out/test/e2e/smoke/**/*.test.js" : "out/test/e2e/**/*.test.js";

// The scheduled Insiders run sets LIBREDB_VSCODE_VERSION=insiders.
const pinned = process.env.LIBREDB_VSCODE_VERSION;
const builds = pinned ? [pinned] : [versions.floor, versions.stable];

export default builds.map((version) => ({
  label: `vscode-${version}`,
  version,
  files,
  // failZero: test-cli hands Mocha an empty file list without an error, so a glob that matches nothing would pass.
  mocha: { ui: "bdd", forbidOnly: true, failZero: true, timeout: 60000 },
}));
