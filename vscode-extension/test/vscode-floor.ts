/**
 * The Node that the floor build's extension host runs: VS Code 1.123.2, the floor in `test/vscode-versions.json`, runs
 * Electron 42.2.0, which carries Node 24.15.0 (part 5, "The `engines.vscode` floor").
 * `test/unit/manifest.test.ts` holds it against the root's `engines.node`.
 */
export const FLOOR_NODE = "24.15.0";

/**
 * The runtime of the stable build `test/vscode-versions.json` pins (1.142.0), as measured [PROBES runs A, H]; the
 * integration leg's `vscode` run holds the child's `initialize` answer to it, and `test/unit/manifest.test.ts` holds
 * the pin it describes.
 */
export const STABLE_RUNTIME = { node: "24.21.0", electron: "43.7.7", modules: "148" };
