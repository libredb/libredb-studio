import assert from "node:assert/strict";
import {
  assertNoViolations,
  childViolations,
  hostViolations,
  inputPackage,
  repoPath,
} from "../../../scripts/bundle-checks.mjs";

const wd = "/repo/vscode-extension";

interface Import {
  path: string;
  kind: string;
  external?: boolean;
}

/** A metafile as esbuild writes it, cut to the fields the checks read. */
function metafile(inputs: string[], externals: string[] = []) {
  const imports: Import[] = externals.map((path) => ({ path, kind: "require-call", external: true }));
  return {
    inputs: Object.fromEntries(inputs.map((path) => [path, {}])),
    outputs: { "dist/x.js": { imports } },
  };
}

describe("repoPath and inputPackage", () => {
  it("names an input by its path from the repository root", () => {
    assert.equal(repoPath("../src/lib/types.ts", wd), "src/lib/types.ts");
    assert.equal(repoPath("src/host/extension.ts", wd), "vscode-extension/src/host/extension.ts");
    assert.equal(repoPath("../node_modules/pg/lib/index.js", wd), "node_modules/pg/lib/index.js");
  });

  it("names the innermost package an input belongs to, a scope kept whole", () => {
    assert.equal(inputPackage("../node_modules/@scope/pkg/dist/a.js"), "@scope/pkg");
    assert.equal(inputPackage("../node_modules/a/node_modules/b/x.js"), "b");
    assert.equal(inputPackage("../src/lib/types.ts"), null);
  });
});

describe("hostViolations", () => {
  const offending = [
    "../src/lib/db/providers/sql/postgres.ts",
    "../src/lib/db/factory.ts",
    "../node_modules/pg/lib/index.js",
    "../src/components/ResultsGrid.tsx",
    "../src/lib/sql/run-target.ts",
    "../src/lib/editor/x.ts",
    "../src/lib/query-generators.ts",
    "../src/lib/db-ui-config.ts",
  ];
  for (const input of offending) {
    it(`refuses ${input}`, () => {
      const violations = hostViolations(metafile(["src/host/extension.ts", input], ["vscode"]), wd);
      assert.equal(violations.length, 1, violations.join("\n"));
      assert.ok(violations[0].startsWith(`${repoPath(input, wd)}: `), violations[0]);
    });
  }

  for (const external of ["pg", "../src/lib/db/factory"]) {
    it(`refuses an external import of ${external}`, () => {
      const violations = hostViolations(metafile(["src/host/extension.ts"], ["vscode", external]), wd);
      assert.deepEqual(violations, [`${external}: an external import other than vscode or a Node builtin`]);
    });
  }

  it("leaves vscode and Node builtins external, with or without the node: prefix", () => {
    const clean = metafile(["src/host/extension.ts"], ["vscode", "node:child_process", "path"]);
    assert.deepEqual(hostViolations(clean, wd), []);
  });

  it("keeps a host of its own sources, LibreDB types, vscode-jsonrpc and an external vscode", () => {
    const clean = metafile(
      ["src/host/extension.ts", "../src/lib/types.ts", "../node_modules/vscode-jsonrpc/lib/node/main.js"],
      ["vscode"],
    );
    assert.deepEqual(hostViolations(clean, wd), []);
  });
});

describe("childViolations", () => {
  const cases: [string, string[], string[], string][] = [
    ["an external vscode", [], ["vscode"], "vscode"],
    ["next", ["../node_modules/next/dist/server/web/exports.js"], [], "node_modules/next/"],
    ["React", ["../node_modules/react/index.js"], [], "node_modules/react/index.js"],
    ["Monaco", ["../node_modules/monaco-editor/esm/x.js"], [], "node_modules/monaco-editor/esm/x.js"],
    ["the governance start", ["../src/lib/governance/start.ts"], [], "src/lib/governance/start.ts"],
    ["the query-events sink", ["../src/lib/query-events/sink.ts"], [], "src/lib/query-events/sink.ts"],
    ["a component", ["../src/components/x.tsx"], [], "src/components/x.tsx"],
    [
      "a native addon input",
      ["../node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node"],
      [],
      "node_modules/ssh2/",
    ],
    ["an external not on CHILD_EXTERNALS", [], ["better-sqlite3"], "better-sqlite3"],
  ];
  for (const [label, inputs, externals, prefix] of cases) {
    it(`refuses ${label}`, () => {
      const violations = childViolations(metafile(["src/backend/main.ts", ...inputs], externals), wd);
      assert.equal(violations.length, 1, violations.join("\n"));
      assert.ok(violations[0].startsWith(prefix), violations[0]);
    });
  }

  it("keeps a child of the factory, a driver, Node built-ins and the listed externals", () => {
    const clean = metafile(
      ["src/backend/main.ts", "../src/lib/db/factory.ts", "../node_modules/pg/lib/index.js"],
      ["node:fs", "fs", "oracledb", "@duckdb/node-api", "../build/Release/sshcrypto.node"],
    );
    assert.deepEqual(childViolations(clean, wd), []);
  });

  it("reports an external imported by two outputs once", () => {
    const twice = metafile(["src/backend/main.ts"], ["vscode"]);
    const outputs = { ...twice.outputs, "dist/y.js": twice.outputs["dist/x.js"] };
    assert.equal(childViolations({ ...twice, outputs }, wd).length, 1);
  });
});

describe("assertNoViolations", () => {
  it("throws one line per violation under the bundle's label", () => {
    assert.throws(() => assertNoViolations("child", ["a: b"]), { message: "child bundle crosses its boundary:\na: b" });
  });

  it("returns nothing on an empty list", () => {
    assert.equal(assertNoViolations("child", []), undefined);
  });
});
