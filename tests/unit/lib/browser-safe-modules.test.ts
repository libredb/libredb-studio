import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** The generated connection tables: frozen literals and type imports only, so loading one loads nothing else. */
const GENERATED_CONNECTION_TABLES = [
  "src/lib/db/engine-catalog/connection.generated.ts",
  "src/lib/db/engine-catalog/connection-flags.generated.ts",
] as const;

/**
 * Modules the connection dialog runs in the browser and the seed loader runs on the server, or that the VS Code
 * extension's results webview bundles, so they may import nothing but types: no React, no icon, no Node built-in, and
 * not endpoint.ts, which imports node:net. Each may also load the generated data it names, a module that is itself
 * literals and type imports only.
 */
const BROWSER_SAFE_MODULES: readonly (readonly [string, readonly string[]])[] = [
  ["src/lib/connection-host-uri.ts", []],
  [
    "src/lib/db/credential-warnings.ts",
    ['import { BUNDLED_CREDENTIAL_WARNINGS } from "./engine-catalog/connection.generated";'],
  ],
  ["src/lib/results/append-page.ts", []],
];

describe("browser-safe modules import types only", () => {
  test.each(BROWSER_SAFE_MODULES)(
    "%s imports nothing but types from @/lib/types and the generated data it names",
    (file, data) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      const imports = source.split("\n").filter((line) => line.startsWith("import "));
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports.filter((line) => !data.includes(line))) {
        expect(line).toMatch(/^import type \{[^}]+\} from "@\/lib\/types";$/);
      }
      for (const line of data) expect(imports).toContain(line);
      expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    },
  );

  test.each(GENERATED_CONNECTION_TABLES)("the generated connection tables in %s import types only", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type \{[^}]+\} from "[^"]+";$/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
