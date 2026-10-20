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
  return inputViolations(metafile, workingDir, HOST_INPUT_RULES);
}

export function childViolations(metafile, workingDir) {
  const violations = inputViolations(metafile, workingDir, CHILD_INPUT_RULES);
  for (const path of externalImports(metafile)) {
    if (path === "vscode") violations.push("vscode: the child never imports vscode");
    else if (!isChildExternal(path)) violations.push(`${path}: an external import that is not on CHILD_EXTERNALS`);
  }
  return violations;
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
];

const CHILD_INPUT_RULES = [
  [(_path, pkg) => pkg === "next", "the child never bundles next"],
  [(_path, pkg) => REACT_PACKAGES.has(pkg), "the child never bundles React"],
  [(_path, pkg) => MONACO_PACKAGES.has(pkg), "the child never bundles Monaco"],
  [(path) => path === "src/lib/governance/start.ts", "the child never bundles the governance start"],
  [(path) => path === "src/lib/query-events/sink.ts", "the child never bundles the query-events sink"],
  [(path) => path.startsWith("src/components/"), "the child never bundles a component"],
  [(path) => path.endsWith(".node"), "the child never bundles a native addon"],
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

/** Every import an output leaves external, once. */
function externalImports(metafile) {
  const paths = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) if (imported.external) paths.add(imported.path);
  }
  return [...paths];
}

function isChildExternal(path) {
  if (path.startsWith("node:") || builtinModules.includes(path)) return true;
  return CHILD_EXTERNALS.some((entry) => {
    if (entry.startsWith("*")) return path.endsWith(entry.slice(1));
    if (entry.endsWith("/*")) return path.startsWith(entry.slice(0, -1));
    return path === entry || path.startsWith(`${entry}/`);
  });
}

function toPosix(path) {
  return path.split("\\").join("/");
}
