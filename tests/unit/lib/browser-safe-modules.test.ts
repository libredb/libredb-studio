import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Modules the connection dialog runs in the browser and the seed loader runs on the server, so they may import
 * nothing but types: no React, no icon, no Node built-in, and not endpoint.ts, which imports node:net.
 */
const BROWSER_SAFE_MODULES = ["src/lib/connection-host-uri.ts", "src/lib/db/credential-warnings.ts"];

describe("browser-safe modules import types only", () => {
  test.each(BROWSER_SAFE_MODULES)("%s imports nothing but types from @/lib/types", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type \{[^}]+\} from "@\/lib\/types";$/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
