import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLibClosure, CREDENTIAL_WARNING_FRAME, requireClosure } from "../../scripts/check-lib-closure.mjs";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway dist directory holding the given files. */
function dist(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-closure-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content, "utf8");
  return root;
}

const GOOD = {
  "components.js": "'use strict';\nvar a = require('./chunk-a.js');\nrequire(\"./chunk-b.js\");\n",
  "chunk-a.js": "function ConnectionModal({ isOpen }) {}\nfunction useConnectionForm({ isOpen }) {}\n",
  "chunk-b.js": `const frame = "${CREDENTIAL_WARNING_FRAME}";\n`,
  "workspace.js": "'use strict';\nrequire('./chunk-c.js');\n",
  "chunk-c.js": "function StudioWorkspace() {}\n",
};

describe("requireClosure", () => {
  test("follows every relative require, in either quote, once each", () => {
    expect(requireClosure(dist(GOOD), "components.js")).toEqual(["chunk-a.js", "chunk-b.js", "components.js"]);
  });

  test("terminates on a require cycle", () => {
    const root = dist({ "e.js": "require('./x.js');", "x.js": "require('./y.js');", "y.js": "require('./x.js');" });
    expect(requireClosure(root, "e.js")).toEqual(["e.js", "x.js", "y.js"]);
  });

  test("throws on a required file that does not exist", () => {
    expect(() => requireClosure(dist({ "e.js": "require('./missing.js');" }), "e.js")).toThrow(/ENOENT/);
  });
});

describe("checkLibClosure", () => {
  test("reports nothing when components carries the frame and workspace carries no dialog", () => {
    expect(checkLibClosure(dist(GOOD))).toEqual([]);
  });

  test("reports each broken claim in its own sentence", () => {
    const root = dist({
      "components.js": "require('./chunk-c.js');",
      "chunk-c.js": "function StudioWorkspace() {}",
      "workspace.js": "require('./chunk-a.js');",
      "chunk-a.js": "function ConnectionModal({ isOpen }) {}\nfunction useConnectionForm({ isOpen }) {}\n",
    });
    expect(checkLibClosure(root)).toEqual([
      `dist/components.js: its require closure does not hold the credential warning frame "${CREDENTIAL_WARNING_FRAME}", so a host mounting ConnectionModal would draw no warning.`,
      "dist/components.js: its require closure holds no ConnectionModal function, so the workspace check would prove nothing.",
      "dist/workspace.js: its require closure holds the ConnectionModal module.",
      "dist/workspace.js: its require closure holds the useConnectionForm module.",
    ]);
  });
});
