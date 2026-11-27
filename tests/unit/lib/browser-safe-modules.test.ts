import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * The generated connection tables, the generated editor record, the generated query editor records, the generated
 * SQL text, SQL writing, migration DDL and SQL generator records and the generated claim requests: frozen literals and
 * type imports only, so loading one loads nothing else. The query editor module imports nothing, since its records carry
 * no annotation.
 */
const GENERATED_MODULES = [
  "src/lib/db/engine-catalog/connection.generated.ts",
  "src/lib/db/engine-catalog/connection-flags.generated.ts",
  "src/lib/db/engine-catalog/connection-form.generated.ts",
  "src/lib/db/engine-catalog/connection-string.generated.ts",
  "src/lib/db/engine-catalog/editor.generated.ts",
  "src/lib/db/engine-catalog/query-editor.generated.ts",
  "src/lib/db/engine-catalog/sql-text.generated.ts",
  "src/lib/db/engine-catalog/sql-writing.generated.ts",
  "src/lib/db/engine-catalog/migration-ddl.generated.ts",
  "src/lib/db/engine-catalog/sql-generators.generated.ts",
  "src/lib/db/engine-catalog/claims.generated.ts",
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

  test.each(GENERATED_MODULES)("the generated module %s imports types only", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(source).toContain("Object.freeze(");
    for (const line of imports) expect(line).toMatch(/^import type \{[^}]+\} from "[^"]+";$/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  test("the generated modules' imports are read: every one but the query editor module imports a type", () => {
    const importing = GENERATED_MODULES.filter((file) =>
      readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .some((line) => line.startsWith("import type ")),
    );

    expect(importing).toEqual(GENERATED_MODULES.filter((file) => !file.endsWith("/query-editor.generated.ts")));
  });
});
