import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialWarningFor } from "@/lib/db/credential-warnings";
import { checkLibClosure, CREDENTIAL_WARNING_FRAME, moduleClosure } from "../../scripts/check-lib-closure.mjs";
import {
  declareCredentialWarnings,
  SYNTHETIC_PAIR,
  SYNTHETIC_PASSWORD,
} from "../helpers/synthetic-credential-warnings";

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
  "components.mjs": "import { ConnectionModal } from './chunk-a.mjs';\nimport \"./chunk-b.mjs\";\n",
  "chunk-a.mjs": "function ConnectionModal({ isOpen }) {}\nfunction useConnectionForm({ isOpen }) {}\n",
  "chunk-b.mjs": `const frame = "${CREDENTIAL_WARNING_FRAME}";\n`,
  "workspace.mjs": "import { StudioWorkspace } from './chunk-c.mjs';\n",
  "chunk-c.mjs": "function StudioWorkspace() {}\n",
};

describe("CREDENTIAL_WARNING_FRAME", () => {
  test("is the frame credentialWarningFor builds its sentence from, so the check looks for the string it ships", () => {
    const restore = declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]);
    try {
      expect(credentialWarningFor("etcd", { user: "root", password: SYNTHETIC_PASSWORD })).toBe(
        `${CREDENTIAL_WARNING_FRAME}${SYNTHETIC_PAIR.message}`,
      );
    } finally {
      restore();
    }
  });
});

describe("moduleClosure", () => {
  test("follows every relative require, in either quote, once each", () => {
    expect(moduleClosure(dist(GOOD), "components.js")).toEqual(["chunk-a.js", "chunk-b.js", "components.js"]);
  });

  test("follows every relative import: a named one, a bare one and a dynamic one", () => {
    const root = dist({
      "e.mjs": "import { a } from './a.mjs';\nimport \"./b.mjs\";\nconst c = () => import('./c.mjs');\n",
      "a.mjs": "export const a = 1;",
      "b.mjs": "",
      "c.mjs": "export const c = 1;",
    });
    expect(moduleClosure(root, "e.mjs")).toEqual(["a.mjs", "b.mjs", "c.mjs", "e.mjs"]);
  });

  test("terminates on a require cycle", () => {
    const root = dist({ "e.js": "require('./x.js');", "x.js": "require('./y.js');", "y.js": "require('./x.js');" });
    expect(moduleClosure(root, "e.js")).toEqual(["e.js", "x.js", "y.js"]);
  });

  test("throws on a required file that does not exist", () => {
    expect(() => moduleClosure(dist({ "e.js": "require('./missing.js');" }), "e.js")).toThrow(/ENOENT/);
  });
});

describe("checkLibClosure", () => {
  test("reports nothing when components carries the frame and workspace carries no dialog", () => {
    expect(checkLibClosure(dist(GOOD))).toEqual([]);
  });

  test("reports a broken claim of the ESM entries, which import-condition hosts load, while CommonJS holds", () => {
    const root = dist({ ...GOOD, "workspace.mjs": "import { ConnectionModal } from './chunk-a.mjs';\n" });
    expect(checkLibClosure(root)).toEqual([
      "dist/workspace.mjs: its import closure holds the ConnectionModal module.",
      "dist/workspace.mjs: its import closure holds the useConnectionForm module.",
    ]);
  });

  test("reports each broken claim in its own sentence", () => {
    const root = dist({
      ...GOOD,
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
