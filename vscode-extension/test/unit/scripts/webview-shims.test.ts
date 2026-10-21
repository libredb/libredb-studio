import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shimPlugin, WEBVIEW_SHIMS } from "../../../scripts/webview-shims.mjs";

const root = join(__dirname, "..", "..", "..");

interface Resolve {
  filter: RegExp;
  callback: (args: { path: string }) => { path: string };
}

/** The onResolve registrations the plugin makes on a stand-in for esbuild's build object. */
function registrations(workingDir: string): Resolve[] {
  const seen: Resolve[] = [];
  shimPlugin(workingDir).setup({
    onResolve: (options: { filter: RegExp }, callback: Resolve["callback"]) => {
      seen.push({ filter: options.filter, callback });
    },
  });
  return seen;
}

describe("the webview's shim table", () => {
  it("replaces exactly the three specifiers of part 4's shim table, each with a file that exists", () => {
    assert.deepEqual(WEBVIEW_SHIMS, {
      sonner: "src/webview/shims/sonner.ts",
      "@/components/copy-button": "src/webview/shims/copy-button.ts",
      "@/lib/storage": "src/webview/shims/storage.ts",
    });
    for (const file of Object.values(WEBVIEW_SHIMS)) assert.ok(existsSync(join(root, file)), file);
  });

  it("matches the unit leg's tsconfig paths, so the tests render against the shims the bundle carries", () => {
    const paths: Record<string, string[]> = JSON.parse(readFileSync(join(root, "tsconfig.test.json"), "utf8"))
      .compilerOptions.paths;
    for (const specifier of ["sonner", "@/components/copy-button"]) {
      assert.deepEqual(paths[specifier], [`./${WEBVIEW_SHIMS[specifier as keyof typeof WEBVIEW_SHIMS]}`], specifier);
    }
  });

  it("registers one onResolve keyed on the exact specifiers, resolved against the working directory", () => {
    const seen = registrations("/repo/vscode-extension");
    assert.equal(seen.length, 1);
    const [{ filter, callback }] = seen;
    for (const specifier of Object.keys(WEBVIEW_SHIMS)) assert.ok(filter.test(specifier), specifier);
    for (const other of [
      "sonner/dist/x",
      "@/lib/storage-facade",
      "x-sonner",
      "@/components/copy-button.tsx",
      "react",
    ]) {
      assert.equal(filter.test(other), false, other);
    }
    assert.deepEqual(callback({ path: "sonner" }), { path: "/repo/vscode-extension/src/webview/shims/sonner.ts" });
    assert.deepEqual(callback({ path: "@/lib/storage" }), {
      path: "/repo/vscode-extension/src/webview/shims/storage.ts",
    });
  });
});
