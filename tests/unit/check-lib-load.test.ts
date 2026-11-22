/**
 * The packed library check (`bun run lib:load`, scripts/check-lib-load.mjs) and the library build's handling of
 * workspace packages (docs/TOOLCHAIN.md, "The packed library loads (`lib:load`)").
 *
 * Every case that spawns a process passes an explicit timeout, and the case that plants a module looping forever
 * runs that module only in the child `node`, which the check bounds by its heap and its timeout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  ancestorNodeModules,
  childEnvironment,
  linkDeclaredDependencies,
  loadFailures,
  moduleSpecifiers,
  packageNameOf,
  packPackage,
  undeclaredSpecifiers,
  workspaceDependencyFailures,
} from "../../scripts/check-lib-load.mjs";
import { workspacePackageManifests, workspacePackageNames } from "../../scripts/workspace-packages.mjs";
import { missingUnixTool, resolveUnixTool, testIf } from "../helpers/posix-tools";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const CHECK_LIB_LOAD = path.join(REPOSITORY_ROOT, "scripts", "check-lib-load.mjs");

const scratchRoots: string[] = [];
afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway directory under the real temporary directory, removed after the file. */
function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  scratchRoots.push(root);
  return root;
}

/** Writes each file relative to `root`, creating its directories. */
function write(root: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe("moduleSpecifiers", () => {
  test("reports every static, dynamic and CommonJS form, in source order", () => {
    const text = [
      'import a from "static-import";',
      'export { b } from "export-from";',
      'import "side-effect";',
      'const c = () => import("dynamic-import");',
      'const d = require("require-call");',
      'const e = require.resolve("require-resolve");',
    ].join("\n");

    expect(moduleSpecifiers(text, "chunk.mjs")).toEqual({
      specifiers: ["static-import", "export-from", "side-effect", "dynamic-import", "require-call", "require-resolve"],
      computed: 0,
    });
  });

  test("reports an import-equals require, an import type node and a triple-slash types reference in a declaration", () => {
    const text = [
      '/// <reference types="triple-slash" />',
      'import x = require("import-equals");',
      'export declare const y: import("import-type").Shape;',
    ].join("\n");

    expect(moduleSpecifiers(text, "index.d.ts").specifiers.sort()).toEqual(
      ["import-equals", "import-type", "triple-slash"].sort(),
    );
  });

  test("reports nothing for specifier-like text inside a string or a template literal", () => {
    const text = [
      "const sql = 'select * from \"AS\"';",
      'const note = `import "inside-template"; require("inside-template")`;',
      "const quoted = \"import x from 'inside-string'\";",
    ].join("\n");

    expect(moduleSpecifiers(text, "chunk.js")).toEqual({ specifiers: [], computed: 0 });
  });

  test("counts an import() and a require() whose argument is computed", () => {
    const text = "const n = 'x';\nimport(n);\nrequire(n);\nrequire.resolve(`a${n}`);\n";

    expect(moduleSpecifiers(text, "chunk.mjs")).toEqual({ specifiers: [], computed: 3 });
  });
});

describe("packageNameOf", () => {
  test("drops a subpath and keeps a scope", () => {
    expect(packageNameOf("yaml")).toBe("yaml");
    expect(packageNameOf("yaml/util")).toBe("yaml");
    expect(packageNameOf("@libredb/planted")).toBe("@libredb/planted");
    expect(packageNameOf("@libredb/planted/dist/x.js")).toBe("@libredb/planted");
  });
});

describe("undeclaredSpecifiers", () => {
  const manifest = { dependencies: { yaml: "1.0.0", react: "19.0.0" }, peerDependencies: { react: "19.0.0" } };
  const peerOnly = { dependencies: {}, peerDependencies: { react: "19.0.0" } };

  function distWith(files: Record<string, string>): string {
    return write(scratch("lib-load-dist-"), files);
  }

  test("names the file and the specifier of an undeclared static import", () => {
    const dist = distWith({ "chunk-p.mjs": 'import "@libredb/planted";\n' });

    expect(undeclaredSpecifiers(dist, manifest).failures).toEqual([
      expect.stringContaining('dist/chunk-p.mjs imports "@libredb/planted"'),
    ]);
  });

  test("names an undeclared require inside a function", () => {
    const dist = distWith({ "chunk-p.js": 'function later() { return require("@libredb/planted"); }\n' });

    expect(undeclaredSpecifiers(dist, manifest).failures).toEqual([
      expect.stringContaining('dist/chunk-p.js imports "@libredb/planted"'),
    ]);
  });

  test("names an undeclared re-export in a declaration file", () => {
    const dist = distWith({ "providers.d.ts": 'export { x } from "@libredb/planted";\n' });

    expect(undeclaredSpecifiers(dist, manifest).failures).toEqual([
      expect.stringContaining('dist/providers.d.ts imports "@libredb/planted"'),
    ]);
  });

  test("names a file with a computed import() as one it cannot check", () => {
    const dist = distWith({ "chunk-q.mjs": "const name = 'x';\nawait import(name);\n" });

    expect(undeclaredSpecifiers(dist, manifest).failures).toEqual([
      expect.stringContaining("dist/chunk-q.mjs has 1 computed import() or require()"),
    ]);
  });

  test("passes a declared package's subpath, a peer, the Node builtins and a Bun runtime module", () => {
    const dist = distWith({
      "a.mjs": 'import "yaml/util";\nimport "node:fs";\nimport "fs";\nconst s = () => import("node:sqlite");\n',
      "b.mjs": 'const b = () => import("bun:sqlite");\n',
      "c.d.ts": 'import type { FC } from "react";\n',
    });

    expect(undeclaredSpecifiers(dist, manifest)).toEqual({ files: 3, failures: [] });
    expect(undeclaredSpecifiers(distWith({ "c.d.mts": 'import type { FC } from "react";\n' }), peerOnly)).toEqual({
      files: 1,
      failures: [],
    });
  });

  test("fails the builtin sqlite without its node: prefix, which Node does not have", () => {
    const dist = distWith({ "a.mjs": 'const s = () => import("sqlite");\n' });

    expect(undeclaredSpecifiers(dist, manifest).failures).toEqual([
      expect.stringContaining('dist/a.mjs imports "sqlite"'),
    ]);
  });

  test("scans a file in a subdirectory and reads no source map or stylesheet", () => {
    const dist = distWith({
      "deep/chunk.js": 'require("undeclared-deep");\n',
      "chunk.mjs.map": '{"sourcesContent":["import \\"undeclared-map\\";"]}',
      "styles.css": '@import "undeclared-css";\n',
    });

    expect(undeclaredSpecifiers(dist, manifest)).toEqual({
      files: 1,
      failures: [expect.stringContaining('dist/deep/chunk.js imports "undeclared-deep"')],
    });
  });
});

describe("workspaceDependencyFailures", () => {
  const planted = { directory: "packages/planted", manifest: { name: "@libredb/planted" } };

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    test(`fails a packed manifest that names a workspace package under ${field}`, () => {
      expect(workspaceDependencyFailures({ [field]: { "@libredb/planted": "0.0.0" } }, [planted])).toEqual([
        expect.stringContaining(`the workspace package "@libredb/planted" under ${field}`),
      ]);
    });
  }

  test("passes a workspace package under devDependencies", () => {
    expect(workspaceDependencyFailures({ devDependencies: { "@libredb/planted": "0.0.0" } }, [planted])).toEqual([]);
  });

  test("fails a workspace package dependency the root does not declare, naming the package and the dependency", () => {
    const driver = {
      directory: "packages/planted",
      manifest: { name: "@libredb/planted", dependencies: { "planted-driver": "1.0.0" } },
    };

    expect(workspaceDependencyFailures({ dependencies: {} }, [driver])).toEqual([
      expect.stringMatching(/^packages\/planted depends on "planted-driver"/),
    ]);
  });

  test("passes a workspace package dependency the root declares as a dependency or a peer", () => {
    const driver = {
      directory: "packages/planted",
      manifest: {
        name: "@libredb/planted",
        dependencies: { "planted-driver": "1.0.0" },
        peerDependencies: { react: "19.0.0" },
      },
    };

    expect(
      workspaceDependencyFailures({ dependencies: { "planted-driver": "1.0.0" }, peerDependencies: { react: "*" } }, [
        driver,
      ]),
    ).toEqual([]);
  });

  test("passes a workspace package that depends on another workspace package", () => {
    const sdk = { directory: "packages/sdk", manifest: { name: "@libredb/sdk" } };
    const user = {
      directory: "packages/user",
      manifest: { name: "@libredb/user", dependencies: { "@libredb/sdk": "workspace:*" } },
    };

    expect(workspaceDependencyFailures({ dependencies: {} }, [sdk, user])).toEqual([]);
  });

  test("the repository has no failure today", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));

    expect(workspaceDependencyFailures(manifest, workspacePackageManifests(REPOSITORY_ROOT))).toEqual([]);
  });
});

describe("isolation of the temporary root", () => {
  test("ancestorNodeModules returns the nearest ancestor holding node_modules, asking once per ancestor", () => {
    const top = path.parse(process.cwd()).root;
    const dir = path.join(top, "a", "b", "c");
    const asked: string[] = [];

    const found = ancestorNodeModules(dir, (candidate: string) => {
      asked.push(candidate);
      return candidate === path.join(top, "a", "node_modules");
    });

    expect(found).toBe(path.join(top, "a"));
    expect(asked).toEqual([path.join(top, "a", "b", "node_modules"), path.join(top, "a", "node_modules")]);
  });

  test("ancestorNodeModules returns null after asking every ancestor up to the root", () => {
    const top = path.parse(process.cwd()).root;
    const dir = path.join(top, "a", "b");
    const asked: string[] = [];

    expect(
      ancestorNodeModules(dir, (candidate: string) => {
        asked.push(candidate);
        return false;
      }),
    ).toBeNull();
    expect(asked).toEqual([path.join(top, "a", "node_modules"), path.join(top, "node_modules")]);
  });

  test("linkDeclaredDependencies links a scoped name, and a name that is both a dependency and a peer once", () => {
    const repository = write(scratch("lib-load-repo-"), {
      "node_modules/@scope/driver/package.json": '{"name":"@scope/driver"}',
      "node_modules/react/package.json": '{"name":"react"}',
    });
    const target = path.join(scratch("lib-load-target-"), "node_modules");

    const linked = linkDeclaredDependencies(
      { dependencies: { "@scope/driver": "1.0.0", react: "19.0.0" }, peerDependencies: { react: "19.0.0" } },
      path.join(repository, "node_modules"),
      target,
    );

    expect(linked).toEqual(["@scope/driver", "react"]);
    expect(readFileSync(path.join(target, "@scope", "driver", "package.json"), "utf8")).toBe(
      '{"name":"@scope/driver"}',
    );
    expect(readFileSync(path.join(target, "react", "package.json"), "utf8")).toBe('{"name":"react"}');
  });

  test("linkDeclaredDependencies refuses a declared name the repository has not installed, by name", () => {
    const repository = write(scratch("lib-load-repo-"), { "node_modules/.keep": "" });
    const target = path.join(scratch("lib-load-target-"), "node_modules");

    expect(() =>
      linkDeclaredDependencies(
        { dependencies: { "missing-driver": "1.0.0" } },
        path.join(repository, "node_modules"),
        target,
      ),
    ).toThrow('"missing-driver" is declared by the packed package.json but is not installed');
  });

  test("childEnvironment drops NODE_PATH and NODE_OPTIONS and points HOME and USERPROFILE at the empty home", () => {
    const home = path.join(path.parse(process.cwd()).root, "empty-home");

    expect(
      childEnvironment(
        { PATH: "/bin", NODE_PATH: "/elsewhere", NODE_OPTIONS: "--require x", HOME: "/home/user" },
        home,
      ),
    ).toEqual({ PATH: "/bin", HOME: home, USERPROFILE: home });
  });
});

describe("loadFailures", () => {
  /** A consumer-shaped install: `<root>/node_modules/planted-lib/dist/...`, with `yaml` linked as declared. */
  function plantedInstall(files: Record<string, string>): {
    packageDir: string;
    env: Record<string, string | undefined>;
  } {
    const root = scratch("lib-load-install-");
    expect(ancestorNodeModules(root, existsSync)).toBeNull();
    const packageDir = path.join(root, "node_modules", "planted-lib");
    write(packageDir, { "package.json": '{"name":"planted-lib","version":"0.0.0"}', ...files });
    linkDeclaredDependencies(
      { dependencies: { yaml: "*" } },
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(root, "node_modules"),
    );
    mkdirSync(path.join(root, "home"));
    return { packageDir, env: childEnvironment(process.env, path.join(root, "home")) };
  }

  test("loads a clean dist, ESM and CJS, a static chunk, a dynamic chunk and a declared dependency", () => {
    const { packageDir, env } = plantedInstall({
      "dist/index.mjs":
        'import "./chunk-a.mjs";\nimport { parse } from "yaml";\nexport const later = () => import("./chunk-d.mjs");\n',
      "dist/chunk-a.mjs": "export const a = 1;\n",
      "dist/chunk-d.mjs": "export const d = 1;\n",
      "dist/index.js": 'require("./chunk-a.js");\nrequire("yaml");\n',
      "dist/chunk-a.js": "exports.a = 1;\n",
    });

    expect(loadFailures(packageDir, ["index.mjs", "index.js"], { env, timeoutMs: 60_000 })).toEqual({
      modules: 5,
      failures: [],
    });
  });

  test("names an ESM chunk importing a package the repository has installed but the package does not declare", () => {
    expect(existsSync(path.join(REPOSITORY_ROOT, "node_modules", "acorn"))).toBe(true);
    const { packageDir, env } = plantedInstall({
      "dist/index.mjs": 'import "./chunk-u.mjs";\n',
      "dist/chunk-u.mjs": 'import "acorn";\n',
    });

    const { failures } = loadFailures(packageDir, ["index.mjs"], { env, timeoutMs: 60_000 });

    expect(failures).toContainEqual(expect.stringMatching(/^dist\/chunk-u\.mjs \(esm\): ERR_MODULE_NOT_FOUND: /));
  });

  test("names a CJS chunk requiring an undeclared package", () => {
    const { packageDir, env } = plantedInstall({
      "dist/index.js": 'require("./chunk-u.js");\n',
      "dist/chunk-u.js": 'require("acorn");\n',
    });

    const { failures } = loadFailures(packageDir, ["index.js"], { env, timeoutMs: 60_000 });

    expect(failures).toContainEqual(expect.stringMatching(/^dist\/chunk-u\.js \(cjs\): MODULE_NOT_FOUND: /));
  });

  test("names a chunk reached only through a dynamic import that throws when it loads", () => {
    const { packageDir, env } = plantedInstall({
      "dist/index.mjs": 'export const later = () => import("./chunk-t.mjs");\n',
      "dist/chunk-t.mjs": 'throw new Error("planted top-level failure");\n',
    });

    expect(loadFailures(packageDir, ["index.mjs"], { env, timeoutMs: 60_000 })).toEqual({
      modules: 2,
      failures: ["dist/chunk-t.mjs (esm): Error: planted top-level failure"],
    });
  });

  test("names a load whose child exits 1 after its summary with no failing module, as a CJS top-level unhandled rejection does", () => {
    const { packageDir, env } = plantedInstall({
      "dist/index.js": 'Promise.reject(new Error("planted rejection at load"));\n',
    });

    expect(loadFailures(packageDir, ["index.js"], { env, timeoutMs: 60_000 })).toEqual({
      modules: 0,
      failures: [
        expect.stringMatching(/^the load child exited 1: checked 1 modules\n[\s\S]*planted rejection at load/),
      ],
    });
  });

  test("names a load that does not finish within its timeout", () => {
    const { packageDir, env } = plantedInstall({ "dist/index.mjs": "while (true) {}\n" });

    expect(loadFailures(packageDir, ["index.mjs"], { env, timeoutMs: 3_000 }).failures).toEqual([
      expect.stringContaining("did not finish within 3 s"),
    ]);
  });
});

describe("packing a planted workspace root", () => {
  testIf(missingUnixTool("tar"), "names a workspace dependency the packed manifest writes as a plain version", () => {
    const root = write(scratch("lib-load-pack-root-"), {
      "package.json": JSON.stringify({
        name: "planted-library",
        version: "1.0.0",
        workspaces: ["packages/*"],
        files: ["dist"],
        dependencies: { "@libredb/planted": "workspace:*" },
      }),
      "dist/index.mjs": "export {};\n",
      "packages/planted/package.json": JSON.stringify({ name: "@libredb/planted", version: "0.0.0" }),
    });
    const temp = scratch("lib-load-pack-temp-");

    const packed = packPackage(root, temp, resolveUnixTool("tar") as string);

    expect(packed.packageDir).toBe(path.join(temp, "node_modules", "planted-library"));
    expect(packed.manifest.dependencies).toEqual({ "@libredb/planted": "0.0.0" });
    expect(existsSync(path.join(packed.packageDir, "dist", "index.mjs"))).toBe(true);
    expect(workspaceDependencyFailures(packed.manifest, workspacePackageManifests(root))).toEqual([
      expect.stringContaining('the workspace package "@libredb/planted" under dependencies'),
    ]);
  });
});

describe("the repository's lib:load wiring", () => {
  test("package.json runs the check as lib:load", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));

    expect(manifest.scripts["lib:load"]).toBe("node scripts/check-lib-load.mjs");
  });

  test("ci.yml runs lib:load in the build job, in the step right after lib:closure", () => {
    const workflow = parse(readFileSync(path.join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    const runs = workflow.jobs["lint-and-build"].steps.map((step) => step.run ?? "");
    const closure = runs.indexOf("bun run lib:closure");

    expect(closure).toBeGreaterThanOrEqual(0);
    expect(runs[closure + 1]).toBe("bun run lib:load");
  });

  test("the check refuses by name when dist/ is missing", () => {
    const root = scratch("lib-load-nodist-");

    const run = spawnSync("node", [CHECK_LIB_LOAD], { cwd: root, encoding: "utf8", timeout: 60_000 });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist/ is missing");
  });

  testIf(
    missingUnixTool("tar"),
    "the check names each entry missing from the packed package and removes its temporary root",
    () => {
      const root = write(scratch("lib-load-noentry-"), {
        "package.json": JSON.stringify({ name: "planted-library", version: "1.0.0", files: ["dist"] }),
        "dist/index.mjs": "export {};\n",
      });
      const temporary = scratch("lib-load-tmpdir-");
      const env = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };

      const run = spawnSync("node", [CHECK_LIB_LOAD], { cwd: root, encoding: "utf8", timeout: 60_000, env });

      expect(run.status).toBe(1);
      for (const entry of ["index.js", "providers.mjs", "providers.js"]) {
        expect(run.stderr).toContain(`dist/${entry} is not in the packed package`);
      }
      expect(run.stderr).not.toContain("dist/index.mjs is not in the packed package");
      expect(readdirSync(temporary)).toEqual([]);
    },
  );

  test("tsup.config.ts bundles every workspace package, code and types", async () => {
    const config = (await import("../../tsup.config")).default as {
      noExternal?: (string | RegExp)[];
      dts?: unknown;
    };
    const names = workspacePackageNames(REPOSITORY_ROOT);

    expect(config.noExternal?.filter((entry) => typeof entry === "string")).toEqual(names);
    expect(config.noExternal?.filter((entry) => entry instanceof RegExp).map((entry) => entry.source)).toEqual([
      "\\.css$",
    ]);
    expect(config.dts).toEqual({ resolve: names });
  });
});
