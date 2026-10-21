// The webview build's module shims (part 4 "Bundling ResultsGrid for the webview", the shim table).
// The plugin is keyed on the exact specifiers, since two of them are @/ paths rather than package names.

import { join } from "node:path";

/** The exact specifiers the webview build replaces, and the file each becomes, from vscode-extension/. */
export const WEBVIEW_SHIMS = {
  sonner: "src/webview/shims/sonner.ts",
  "@/components/copy-button": "src/webview/shims/copy-button.ts",
  "@/lib/storage": "src/webview/shims/storage.ts",
};

const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** esbuild's onResolve plugin keyed on those exact strings, resolved against workingDir. */
export function shimPlugin(workingDir) {
  const filter = new RegExp(`^(${Object.keys(WEBVIEW_SHIMS).map(escape).join("|")})$`);
  return {
    name: "libredb-webview-shims",
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: join(workingDir, WEBVIEW_SHIMS[args.path]) }));
    },
  };
}
