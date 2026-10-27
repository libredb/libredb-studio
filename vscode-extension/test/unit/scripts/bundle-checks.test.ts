import assert from "node:assert/strict";
import {
  assertNoViolations,
  CHILD_ALIASES,
  CHILD_IMPORT_META,
  childViolations,
  hostViolations,
  inputPackage,
  OPTIONAL_REQUIRES,
  repoPath,
  WEBVIEW_FORBIDDEN_PACKAGES,
  WEBVIEW_SINGLE_COPY,
  webviewOutputViolations,
  webviewViolations,
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

/** A host metafile with one input and no external import. */
function hostInput(input: string) {
  return {
    inputs: { [input]: { bytes: 1, imports: [] } },
    outputs: { "dist/extension.js": { bytes: 1, inputs: {}, imports: [] } },
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

  // The host splits a connection's secrets through P7's leaf; the modules that seal them on the server stay out.
  const serverOnly: [string, string][] = [
    [
      "src/lib/storage/encryption.ts",
      "the host never bundles the server's storage encryption; it splits secrets through src/lib/storage/secret-fields.ts",
    ],
    [
      "src/lib/storage/connection-secrets.ts",
      "the host never bundles connection-secrets; it splits secrets through src/lib/storage/secret-fields.ts",
    ],
    ["src/lib/config/auth-env.ts", "the host never bundles the server's auth environment"],
  ];
  for (const [path, rule] of serverOnly) {
    it(`refuses ${path}, which the child may bundle`, () => {
      assert.deepEqual(hostViolations(hostInput(`../${path}`), wd), [`${path}: ${rule}`]);
      const child = {
        ...hostInput(`../${path}`),
        outputs: { "dist/backend.js": { bytes: 1, inputs: {}, imports: [] } },
      };
      assert.deepEqual(childViolations(child, wd), []);
    });
  }

  // Part 3 criterion 23: what the child bundles for the editors stays out of the host, each by its own rule.
  const childOnly: [string, string][] = [
    ["src/lib/sql/run-target.ts", "the host never bundles src/lib/sql"],
    ["src/lib/editor/tab-language.ts", "the host never bundles src/lib/editor"],
    ["src/lib/query-generators.ts", "the host never bundles the query generators"],
  ];
  for (const [path, rule] of childOnly) {
    it(`refuses ${path} with its rule's sentence`, () => {
      assert.deepEqual(hostViolations(hostInput(`../${path}`), wd), [`${path}: ${rule}`]);
    });
  }

  it("keeps the secret-field leaf and the id generator", () => {
    assert.deepEqual(hostViolations(hostInput("../src/lib/storage/secret-fields.ts"), wd), []);
    assert.deepEqual(hostViolations(hostInput("../src/lib/ids.ts"), wd), []);
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
    [
      "the wasm-utils entry that reads its .wasm by import.meta.url",
      ["../node_modules/@platformatic/wasm-utils/dist/index.js"],
      [],
      "node_modules/@platformatic/wasm-utils/dist/index.js",
    ],
  ];
  for (const [label, inputs, externals, prefix] of cases) {
    it(`refuses ${label}`, () => {
      const violations = childViolations(metafile(["src/backend/main.ts", ...inputs], externals), wd);
      assert.equal(violations.length, 1, violations.join("\n"));
      assert.ok(violations[0].startsWith(prefix), violations[0]);
    });
  }

  it("gives the CJS child an import.meta.url and filename of its own file, and fails the build on any other empty import.meta", () => {
    assert.deepEqual(CHILD_IMPORT_META.inject, ["scripts/child-import-meta.mjs"]);
    assert.deepEqual(CHILD_IMPORT_META.define, {
      "import.meta.url": "libredbImportMetaUrl",
      "import.meta.filename": "__filename",
    });
    assert.deepEqual(CHILD_IMPORT_META.logOverride, { "empty-import-meta": "error" });
  });

  it("keeps the wasm-utils entry that carries its .wasm inline, which CHILD_ALIASES points the Kafka driver at", () => {
    assert.deepEqual(CHILD_ALIASES, { "@platformatic/wasm-utils": "@platformatic/wasm-utils/bundled" });
    const clean = metafile(["src/backend/main.ts", "../node_modules/@platformatic/wasm-utils/dist/bundled.js"]);
    assert.deepEqual(childViolations(clean, wd), []);
  });

  it("keeps a child of the factory, a driver, Node built-ins and the listed externals", () => {
    const clean = metafile(
      ["src/backend/main.ts", "../src/lib/db/factory.ts", "../node_modules/pg/lib/index.js"],
      ["node:fs", "fs", "oracledb", "@duckdb/node-api", "../build/Release/sshcrypto.node"],
    );
    assert.deepEqual(childViolations(clean, wd), []);
  });

  // Part 3 "Backend additions" 3: the child takes in the editor language, the generators and the run target, whose
  // Monaco imports are type-only, so Monaco itself never reaches it.
  it("keeps a child of the editor language, the dialect editors, the generators and the run target", () => {
    const clean = metafile([
      "src/backend/main.ts",
      "../src/lib/editor/tab-language.ts",
      "../src/lib/editor/dialect-editors.ts",
      "../src/lib/query-generators.ts",
      "../src/lib/sql/run-target.ts",
    ]);
    assert.deepEqual(childViolations(clean, wd), []);
  });

  it("refuses Monaco's editor API as one violation naming monaco-editor", () => {
    const monaco = "../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
    assert.deepEqual(childViolations(metafile(["src/backend/main.ts", monaco]), wd), [
      "node_modules/monaco-editor/esm/vs/editor/editor.api.js: the child never bundles Monaco",
    ]);
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

describe("webviewViolations", () => {
  const grammar = "../src/lib/db/sql-grammar/index.ts";
  const postgresGrammar = "../src/lib/db/providers/sql/postgres/grammar.ts";
  const redisText = "../src/lib/db/providers/keyvalue/redis-command-text.ts";
  const singles = [
    "../node_modules/react/index.js",
    "../node_modules/react-dom/client.js",
    "../node_modules/get-nonce/dist/es5/index.js",
  ];

  /** A clean webview metafile, with `extra` inputs added and `imports` edges ([importer, imported]) on the inputs. */
  function webview(extra: string[] = [], options: { drop?: string[]; externals?: string[] } = {}) {
    const edges: [string, string][] = [
      [grammar, postgresGrammar],
      [postgresGrammar, redisText],
    ];
    const inputs = [
      "src/webview/main.tsx",
      "../src/components/ResultsGrid.tsx",
      grammar,
      postgresGrammar,
      redisText,
      ...singles,
      ...extra,
    ].filter((input) => !options.drop?.includes(input));
    const externals = (options.externals ?? []).map((path) => ({ path, kind: "import-statement", external: true }));
    return {
      inputs: Object.fromEntries(
        inputs.map((input) => [
          input,
          {
            bytes: 1,
            imports: edges.filter(([from]) => from === input).map(([, path]) => ({ path, kind: "import-statement" })),
          },
        ]),
      ),
      outputs: { "dist/webview/results.js": { imports: externals } },
    };
  }

  it("keeps a webview of its sources, the grid, the sql-grammar rows and one React, React DOM and get-nonce", () => {
    assert.deepEqual(webviewViolations(webview(), wd), []);
  });

  it("names the packages it refuses and the ones it needs exactly once", () => {
    assert.deepEqual(WEBVIEW_FORBIDDEN_PACKAGES, [
      "next",
      "monaco-editor",
      "@monaco-editor/react",
      "@monaco-editor/loader",
      "sonner",
      "pg",
      "mysql2",
      "mssql",
      "tedious",
      "mongodb",
    ]);
    assert.deepEqual(WEBVIEW_SINGLE_COPY, ["react", "react-dom", "get-nonce"]);
  });

  it("refuses an external import", () => {
    assert.deepEqual(webviewViolations(webview([], { externals: ["vscode"] }), wd), [
      "vscode: the webview leaves nothing external",
    ]);
  });

  for (const input of [
    "../node_modules/next/dist/x.js",
    "../node_modules/monaco-editor/esm/x.js",
    "../node_modules/sonner/dist/index.mjs",
    "../node_modules/pg/lib/index.js",
  ]) {
    it(`refuses ${input}`, () => {
      assert.deepEqual(webviewViolations(webview([input]), wd), [
        `${repoPath(input, wd)}: the webview never bundles ${inputPackage(input)}`,
      ]);
    });
  }

  it("refuses a provider file no sql-grammar row reaches", () => {
    assert.deepEqual(webviewViolations(webview(["../src/lib/db/providers/sql/postgres.ts"]), wd), [
      "src/lib/db/providers/sql/postgres.ts: the webview bundles a provider file that no sql-grammar row reaches",
    ]);
  });

  it("refuses host and backend code", () => {
    for (const input of ["src/host/results/html.ts", "src/backend/main.ts"]) {
      assert.deepEqual(webviewViolations(webview([input]), wd), [
        `vscode-extension/${input}: the webview never bundles host or backend code`,
      ]);
    }
  });

  it("refuses a second React directory", () => {
    assert.deepEqual(webviewViolations(webview(["../node_modules/@radix-ui/x/node_modules/react/index.js"]), wd), [
      "react: react is bundled from 2 directories",
    ]);
  });

  it("refuses a webview without get-nonce", () => {
    assert.deepEqual(webviewViolations(webview([], { drop: ["../node_modules/get-nonce/dist/es5/index.js"] }), wd), [
      "get-nonce: get-nonce is bundled from 0 directories",
    ]);
  });
});

describe("webviewOutputViolations", () => {
  const meta = (...outputs: string[]) => ({
    inputs: {},
    outputs: Object.fromEntries(outputs.map((output) => [output, { imports: [] }])),
  });
  const one = meta("dist/webview/results.js");

  it("keeps one IIFE script with no eval and no new Function, minified or not", () => {
    assert.deepEqual(webviewOutputViolations(one, "(()=>{var a=1;})();\n"), []);
    assert.deepEqual(webviewOutputViolations(one, '"use strict";(()=>{var a=1;})();\n'), []);
    assert.deepEqual(
      webviewOutputViolations(
        meta("dist/webview/results.js", "dist/webview/results.js.map"),
        '"use strict";\n(() => {\n})();\n',
      ),
      [],
    );
  });

  it("refuses a webview with other than one script output", () => {
    assert.deepEqual(webviewOutputViolations(meta("dist/webview/results.js", "dist/webview/chunk.js"), "(()=>{})();"), [
      "dist/webview: the webview is one script, results.js, and esbuild wrote 2",
    ]);
  });

  it("refuses a script that is not an IIFE, or that evaluates text", () => {
    assert.deepEqual(webviewOutputViolations(one, "export const a=1;"), [
      "dist/webview/results.js: the webview script is not an IIFE",
    ]);
    assert.deepEqual(webviewOutputViolations(one, "(()=>{eval(x);new Function(y)})();"), [
      "dist/webview/results.js: the webview script calls eval(",
      "dist/webview/results.js: the webview script calls new Function",
    ]);
  });
});
