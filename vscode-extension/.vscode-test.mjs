// The e2e leg's @vscode/test-cli configuration (part 5, "Tests"): two configurations per pinned VS Code build, running
// the esbuild-bundled test files in out/ against the production dist/. The second opens test/e2e-workspace/fixture, so
// the connections setting is checked against a workspace value; the smoke subset runs neither it nor a file that needs
// Docker.
import versions from "./test/vscode-versions.json" with { type: "json" };

/** The configurations for an environment's LIBREDB_E2E_SUBSET and LIBREDB_VSCODE_VERSION. */
export function configurationsFor(env) {
  const subset = env.LIBREDB_E2E_SUBSET;
  if (subset !== undefined && subset !== "smoke") {
    throw new Error(`LIBREDB_E2E_SUBSET is "${subset}"; set it to smoke or leave it unset.`);
  }
  const smoke = subset === "smoke";
  // The scheduled Insiders run sets LIBREDB_VSCODE_VERSION=insiders.
  const pinned = env.LIBREDB_VSCODE_VERSION;
  const builds = pinned ? [pinned] : [versions.floor, versions.stable];
  // failZero: test-cli hands Mocha an empty file list without an error, so a glob that matches nothing would pass.
  const mocha = { ui: "bdd", forbidOnly: true, failZero: true, timeout: 60000 };
  return builds.flatMap((version) => [
    {
      label: `vscode-${version}`,
      version,
      files: smoke ? "out/test/e2e/smoke/**/*.test.js" : "out/test/e2e/**/*.test.js",
      mocha,
    },
    ...(smoke
      ? []
      : [
          {
            label: `vscode-${version}-workspace`,
            version,
            files: "out/test/e2e-workspace/**/*.test.js",
            workspaceFolder: "test/e2e-workspace/fixture",
            mocha,
          },
        ]),
  ]);
}

export default configurationsFor(process.env);
