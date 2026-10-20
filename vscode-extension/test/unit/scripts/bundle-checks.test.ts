import assert from "node:assert/strict";
import {
  assertNoViolations,
  childViolations,
  hostViolations,
  inputPackage,
  OPTIONAL_REQUIRES,
  repoPath,
} from "../../../scripts/bundle-checks.mjs";

const wd = "/repo/vscode-extension";

interface Import {
  path: string;
  kind: string;
  external?: boolean;
}

/**
 * A metafile as esbuild writes it, cut to the fields the checks read: each external import is listed under the
 * input that makes it (here the first) and under the output that carries it.
 */
function metafile(inputs: string[], externals: string[] = []) {
  const imports: Import[] = externals.map((path) => ({ path, kind: "require-call", external: true }));
  return {
    inputs: Object.fromEntries(inputs.map((path, at) => [path, { bytes: 1, imports: at === 0 ? imports : [] }])),
    outputs: { "dist/x.js": { imports } },
  };
}

/** One input that leaves one import external, and the output that carries it, as esbuild writes both. */
function oneExternal(importer: string, path: string, kind: string) {
  return {
    inputs: { [importer]: { bytes: 1, imports: [{ path, kind, external: true }] } },
    outputs: { "dist/backend.js": { bytes: 1, inputs: {}, imports: [{ path, kind, external: true }] } },
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
    ["an external on neither CHILD_EXTERNALS nor OPTIONAL_REQUIRES", [], ["better-sqlite3"], "better-sqlite3"],
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

  it("reports vscode, or an external on neither list, once however many inputs import it", () => {
    const twice = metafile(["src/backend/main.ts", "src/backend/start.ts"], ["vscode", "left-pad"]);
    twice.inputs["src/backend/start.ts"].imports = twice.inputs["src/backend/main.ts"].imports;
    assert.deepEqual(childViolations(twice, wd), [
      "vscode: the child never imports vscode",
      "left-pad: an external import that is not on CHILD_EXTERNALS or OPTIONAL_REQUIRES",
    ]);
  });
});

describe("childViolations and OPTIONAL_REQUIRES", () => {
  it("names the nine optional packages the bundled drivers require inside their own try", () => {
    assert.deepEqual(Object.keys(OPTIONAL_REQUIRES).sort(), [
      "@aws-sdk/credential-providers",
      "@mongodb-js/zstd",
      "cardinal",
      "gcp-metadata",
      "kerberos",
      "mongodb-client-encryption",
      "pg-native",
      "snappy",
      "socks",
    ]);
  });

  it("accepts an optional require() from a package OPTIONAL_REQUIRES names for it", () => {
    assert.deepEqual(
      childViolations(oneExternal("../node_modules/mongodb/lib/deps.js", "snappy", "require-call"), wd),
      [],
    );
    assert.deepEqual(
      childViolations(oneExternal("../node_modules/pg/lib/native/client.js", "pg-native", "require-call"), wd),
      [],
    );
    assert.deepEqual(
      childViolations(
        oneExternal("../node_modules/cassandra-driver/lib/insights-client.js", "kerberos", "require-call"),
        wd,
      ),
      [],
    );
  });

  it("refuses an optional require from a package OPTIONAL_REQUIRES does not name for it", () => {
    assert.deepEqual(childViolations(oneExternal("../node_modules/pg/lib/client.js", "snappy", "require-call"), wd), [
      "snappy: required from node_modules/pg/lib/client.js, but OPTIONAL_REQUIRES lets only mongodb require it",
    ]);
  });

  it("refuses an optional require from first-party code, which never makes one", () => {
    assert.deepEqual(childViolations(oneExternal("../src/lib/db/x.ts", "kerberos", "require-call"), wd), [
      "kerberos: required from src/lib/db/x.ts, but OPTIONAL_REQUIRES lets only mongodb, cassandra-driver require it",
    ]);
  });

  it("refuses an optional package imported other than by a require() call", () => {
    assert.deepEqual(
      childViolations(oneExternal("../node_modules/mongodb/lib/deps.js", "snappy", "import-statement"), wd),
      [
        "snappy: imported by import-statement from node_modules/mongodb/lib/deps.js; an optional require must be a require() call",
      ],
    );
  });

  it("refuses a require() of a package on neither list, whoever makes it", () => {
    assert.deepEqual(
      childViolations(oneExternal("../node_modules/mongodb/lib/deps.js", "left-pad", "require-call"), wd),
      ["left-pad: an external import that is not on CHILD_EXTERNALS or OPTIONAL_REQUIRES"],
    );
  });

  it("ignores what an input lists as external but no output leaves external: an elided type import, esbuild's runtime", () => {
    const elided = {
      inputs: {
        "../src/lib/db/providers/document/mongodb/agent-read.ts": {
          bytes: 1,
          imports: [
            { path: "mongodb", kind: "import-statement", external: true },
            { path: "<runtime>", kind: "import-statement", external: true },
            { path: "snappy", kind: "import-statement", external: true },
          ],
        },
      },
      outputs: { "dist/backend.js": { bytes: 1, inputs: {}, imports: [] } },
    };
    assert.deepEqual(childViolations(elided, wd), []);
  });

  it("refuses an optional package an output leaves external when no input imports it", () => {
    const orphan = {
      inputs: { "src/backend/main.ts": { bytes: 1, imports: [] } },
      outputs: {
        "dist/backend.js": {
          bytes: 1,
          inputs: {},
          imports: [{ path: "snappy", kind: "require-call", external: true }],
        },
      },
    };
    assert.deepEqual(childViolations(orphan, wd), ["snappy: an output leaves it external, but no input imports it"]);
  });

  it("reports an optional require once per offending importer", () => {
    const record = { path: "snappy", kind: "require-call", external: true };
    const twice = {
      inputs: {
        "../node_modules/pg/lib/client.js": { bytes: 1, imports: [record, record] },
        "../node_modules/pg/lib/index.js": { bytes: 1, imports: [record] },
      },
      outputs: { "dist/backend.js": { bytes: 1, inputs: {}, imports: [record] } },
    };
    assert.deepEqual(childViolations(twice, wd), [
      "snappy: required from node_modules/pg/lib/client.js, but OPTIONAL_REQUIRES lets only mongodb require it",
      "snappy: required from node_modules/pg/lib/index.js, but OPTIONAL_REQUIRES lets only mongodb require it",
    ]);
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
