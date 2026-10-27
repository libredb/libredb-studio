// The metafile checks of part 5 "Builds": each bundle keeps its boundary, or the build fails.
// esbuild names an input by its path from absWorkingDir (vscode-extension/), always with forward slashes,
// so root files read "../src/..." and root packages "../node_modules/...".

import { builtinModules } from "node:module";
import { posix } from "node:path";

/** The imports the child leaves to a runtime require (part 5, "The child's externals"). */
export const CHILD_EXTERNALS = [
  "bun:sqlite",
  "@duckdb/*",
  "db2-node",
  "oracledb",
  "cpu-features",
  "proper-lockfile",
  "*.node",
];

/**
 * Imports the child resolves to another entry of the same package (esbuild's alias). @platformatic/wasm-utils, which
 * the Kafka driver imports, reads its native.wasm through new URL(..., import.meta.url), and a CJS bundle has no
 * import.meta.url; its ./bundled entry carries the same module inline.
 */
export const CHILD_ALIASES = { "@platformatic/wasm-utils": "@platformatic/wasm-utils/bundled" };

/**
 * The child is CJS, where esbuild leaves import.meta empty, so a driver's createRequire(import.meta.url) throws at load
 * (the Kafka driver's schema registry module does). The injected module and the define give import.meta.url and
 * filename the child's own file, and the override turns any import.meta still left empty into a build error.
 */
export const CHILD_IMPORT_META = {
  inject: ["scripts/child-import-meta.mjs"],
  define: { "import.meta.url": "libredbImportMetaUrl", "import.meta.filename": "__filename" },
  logOverride: { "empty-import-meta": "error" },
};

/**
 * Optional packages the bundled drivers require inside their own try, none installed: import -> packages allowed to require it.
 * esbuild leaves such a require() for the runtime, where it throws MODULE_NOT_FOUND into the driver's own catch,
 * so the driver runs without that feature; the child accepts one only as a require() call from a package named here.
 */
export const OPTIONAL_REQUIRES = {
  "pg-native": ["pg"],
  cardinal: ["mysql2"],
  kerberos: ["mongodb", "cassandra-driver"],
  "@mongodb-js/zstd": ["mongodb"],
  "@aws-sdk/credential-providers": ["mongodb"],
  "gcp-metadata": ["mongodb"],
  snappy: ["mongodb"],
  socks: ["mongodb"],
  "mongodb-client-encryption": ["mongodb"],
};

/** "vscode-extension/src/host/extension.ts", "src/lib/types.ts" or "node_modules/pg/lib/index.js": the input's path from the repository root. */
export function repoPath(input, workingDir) {
  const root = posix.dirname(toPosix(workingDir));
  return posix.relative(root, posix.resolve(toPosix(workingDir), input));
}

/** The package an input belongs to, the innermost node_modules segment ("@scope/name" kept whole), or null. */
export function inputPackage(path) {
  const segments = path.split("/");
  const at = segments.lastIndexOf("node_modules");
  if (at === -1) return null;
  const name = segments[at + 1];
  return name.startsWith("@") ? `${name}/${segments[at + 2]}` : name;
}

/** Each returns ["<repo path or import>: <rule>"], empty when the bundle keeps its boundary. */
export function hostViolations(metafile, workingDir) {
  const violations = inputViolations(metafile, workingDir, HOST_INPUT_RULES);
  for (const path of externalImports(metafile)) {
    if (path !== "vscode" && !isBuiltin(path)) {
      violations.push(`${path}: an external import other than vscode or a Node builtin`);
    }
  }
  return violations;
}

/**
 * The outputs say which imports stay external, and the inputs say who makes each one and how: an input also lists
 * as external an import TypeScript elides and esbuild's own <runtime>, though neither reaches the bundle.
 */
export function childViolations(metafile, workingDir) {
  const violations = inputViolations(metafile, workingDir, CHILD_INPUT_RULES);
  const importers = externalImporters(metafile);
  for (const path of externalImports(metafile)) {
    if (path === "vscode") violations.push("vscode: the child never imports vscode");
    else if (isChildExternal(path)) continue;
    else if (Object.hasOwn(OPTIONAL_REQUIRES, path)) {
      violations.push(...optionalRequireViolations(path, importers.get(path) ?? [], workingDir));
    } else violations.push(`${path}: an external import that is not on CHILD_EXTERNALS or OPTIONAL_REQUIRES`);
  }
  return violations;
}

/** Packages the webview must never carry: next, Monaco, the replaced sonner, and the v0 drivers. */
export const WEBVIEW_FORBIDDEN_PACKAGES = [
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
];

/** Packages the webview must carry from exactly one directory: two Reacts break hooks, two get-nonce copies lose the nonce. */
export const WEBVIEW_SINGLE_COPY = ["react", "react-dom", "get-nonce"];

const SQL_GRAMMAR_INDEX = "src/lib/db/sql-grammar/index.ts";
const PROVIDERS_DIR = "src/lib/db/providers/";

/**
 * The webview's input rules (part 4 criterion 3). Drivers reach a bundle only through a provider module, which the
 * closure rule refuses; the driver names are kept beside it because pg is also imported outside the providers.
 */
export function webviewViolations(metafile, workingDir) {
  const violations = externalImports(metafile).map((path) => `${path}: the webview leaves nothing external`);
  const reached = providersReachedFromSqlGrammar(metafile, workingDir);
  const directories = new Map(WEBVIEW_SINGLE_COPY.map((name) => [name, new Set()]));
  for (const input of Object.keys(metafile.inputs)) {
    const path = repoPath(input, workingDir);
    const pkg = inputPackage(input);
    if (directories.has(pkg)) directories.get(pkg).add(packageDirectory(input, pkg));
    if (WEBVIEW_FORBIDDEN_PACKAGES.includes(pkg)) violations.push(`${path}: the webview never bundles ${pkg}`);
    else if (path.startsWith(PROVIDERS_DIR) && !reached.has(path)) {
      violations.push(`${path}: the webview bundles a provider file that no sql-grammar row reaches`);
    } else if (path.startsWith("vscode-extension/src/host/") || path.startsWith("vscode-extension/src/backend/")) {
      violations.push(`${path}: the webview never bundles host or backend code`);
    }
  }
  for (const [name, found] of directories) {
    if (found.size !== 1) violations.push(`${name}: ${name} is bundled from ${found.size} directories`);
  }
  return violations;
}

/** The webview's output rules: one script, results.js, an IIFE (the entry reads document.currentScript), no eval. */
export function webviewOutputViolations(metafile, code) {
  const scripts = Object.keys(metafile.outputs).filter((output) => output.endsWith(".js"));
  if (scripts.length !== 1 || !scripts[0].endsWith("/results.js")) {
    return [`dist/webview: the webview is one script, results.js, and esbuild wrote ${scripts.length}`];
  }
  const violations = [];
  if (!/^(?:"use strict";\s*)?\(\(\)\s*=>\s*\{/.test(code))
    violations.push(`${scripts[0]}: the webview script is not an IIFE`);
  for (const call of ["eval(", "new Function"]) {
    if (code.includes(call)) violations.push(`${scripts[0]}: the webview script calls ${call}`);
  }
  return violations;
}

/** The provider files the sql-grammar index reaches, following imports among inputs under the providers directory only. */
function providersReachedFromSqlGrammar(metafile, workingDir) {
  const reached = new Set();
  const index = Object.keys(metafile.inputs).find((input) => repoPath(input, workingDir) === SQL_GRAMMAR_INDEX);
  const queue = index === undefined ? [] : [index];
  while (queue.length > 0) {
    for (const imported of metafile.inputs[queue.shift()]?.imports ?? []) {
      const path = repoPath(imported.path, workingDir);
      if (!path.startsWith(PROVIDERS_DIR) || reached.has(path)) continue;
      reached.add(path);
      queue.push(imported.path);
    }
  }
  return reached;
}

/** "../node_modules/a/node_modules/react/index.js" -> "../node_modules/a/node_modules/react/". */
function packageDirectory(input, pkg) {
  const marker = `node_modules/${pkg}/`;
  return input.slice(0, input.lastIndexOf(marker) + marker.length);
}

/** Throws Error("<label> bundle crosses its boundary:\n<one violation per line>") on a non-empty list. */
export function assertNoViolations(label, violations) {
  if (violations.length > 0) throw new Error(`${label} bundle crosses its boundary:\n${violations.join("\n")}`);
}

const HOST_PACKAGES = new Set(["vscode-jsonrpc"]);
const REACT_PACKAGES = new Set(["react", "react-dom"]);
const MONACO_PACKAGES = new Set(["monaco-editor", "@monaco-editor/react", "@monaco-editor/loader"]);

/** [test on (repo path, package), rule]; an input reports the first rule it breaks. */
const HOST_INPUT_RULES = [
  [(path) => path.startsWith("src/lib/db/providers/"), "the host never bundles a provider"],
  [(path) => path === "src/lib/db/factory.ts", "the host never bundles the provider factory"],
  [(_path, pkg) => pkg !== null && !HOST_PACKAGES.has(pkg), "the host's only package is vscode-jsonrpc"],
  [(path) => path.startsWith("src/components/"), "the host never bundles a component"],
  [(path) => path.startsWith("src/lib/sql/"), "the host never bundles src/lib/sql"],
  [(path) => path.startsWith("src/lib/editor/"), "the host never bundles src/lib/editor"],
  [(path) => path === "src/lib/query-generators.ts", "the host never bundles the query generators"],
  [(path) => path === "src/lib/db-ui-config.ts", "the host never bundles the UI configuration"],
  [
    (path) => path === "src/lib/storage/encryption.ts",
    "the host never bundles the server's storage encryption; it splits secrets through src/lib/storage/secret-fields.ts",
  ],
  [
    (path) => path === "src/lib/storage/connection-secrets.ts",
    "the host never bundles connection-secrets; it splits secrets through src/lib/storage/secret-fields.ts",
  ],
  [(path) => path === "src/lib/config/auth-env.ts", "the host never bundles the server's auth environment"],
];

const CHILD_INPUT_RULES = [
  [(_path, pkg) => pkg === "next", "the child never bundles next"],
  [(_path, pkg) => REACT_PACKAGES.has(pkg), "the child never bundles React"],
  [(_path, pkg) => MONACO_PACKAGES.has(pkg), "the child never bundles Monaco"],
  [(path) => path === "src/lib/governance/start.ts", "the child never bundles the governance start"],
  [(path) => path === "src/lib/query-events/sink.ts", "the child never bundles the query-events sink"],
  [(path) => path.startsWith("src/components/"), "the child never bundles a component"],
  [(path) => path.endsWith(".node"), "the child never bundles a native addon"],
  [
    (path) => path.endsWith("node_modules/@platformatic/wasm-utils/dist/index.js"),
    "the child bundles wasm-utils through CHILD_ALIASES, since this entry reads its .wasm by import.meta.url",
  ],
];

function inputViolations(metafile, workingDir, rules) {
  const violations = [];
  for (const input of Object.keys(metafile.inputs)) {
    const path = repoPath(input, workingDir);
    const pkg = inputPackage(input);
    const broken = rules.find(([test]) => test(path, pkg));
    if (broken) violations.push(`${path}: ${broken[1]}`);
  }
  return violations;
}

/** Each import an input lists as external, by path: the inputs that make it and esbuild's kind for each. */
function externalImporters(metafile) {
  const importers = new Map();
  for (const [importer, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      if (!imported.external) continue;
      if (!importers.has(imported.path)) importers.set(imported.path, []);
      importers.get(imported.path).push({ importer, kind: imported.kind });
    }
  }
  return importers;
}

/** One violation per input that makes this optional import other than as a require() call or from outside its packages. */
function optionalRequireViolations(path, records, workingDir) {
  if (records.length === 0) return [`${path}: an output leaves it external, but no input imports it`];
  const requirers = OPTIONAL_REQUIRES[path];
  const violations = new Set();
  for (const { importer, kind } of records) {
    const from = repoPath(importer, workingDir);
    if (kind !== "require-call") {
      violations.add(`${path}: imported by ${kind} from ${from}; an optional require must be a require() call`);
    } else if (!requirers.includes(inputPackage(importer))) {
      violations.add(
        `${path}: required from ${from}, but OPTIONAL_REQUIRES lets only ${requirers.join(", ")} require it`,
      );
    }
  }
  return [...violations];
}

/** Every import an output leaves external, once. */
function externalImports(metafile) {
  const paths = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) if (imported.external) paths.add(imported.path);
  }
  return [...paths];
}

function isBuiltin(path) {
  return path.startsWith("node:") || builtinModules.includes(path);
}

function isChildExternal(path) {
  if (isBuiltin(path)) return true;
  return CHILD_EXTERNALS.some((entry) => {
    if (entry.startsWith("*")) return path.endsWith(entry.slice(1));
    if (entry.endsWith("/*")) return path.startsWith(entry.slice(0, -1));
    return path === entry || path.startsWith(`${entry}/`);
  });
}

function toPosix(path) {
  return path.split("\\").join("/");
}
