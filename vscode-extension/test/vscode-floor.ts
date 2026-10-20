/**
 * The Node that the floor build's extension host runs: VS Code 1.123 ships Electron 42.3.0, which carries Node 24.15.0
 * (part 5, "The `engines.vscode` floor"). `test/unit/manifest.test.ts` holds it against the root's `engines.node`.
 */
export const FLOOR_NODE = "24.15.0";
