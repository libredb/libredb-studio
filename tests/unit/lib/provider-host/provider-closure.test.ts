/**
 * The import closure of a provider package (src/lib/provider-host/provider-closure.ts): every recorded import of its
 * module files is a built-in or a relative path that stays inside the package's directory, and every bare specifier is
 * outside, whether an import or a require names it. The check reads only the record, never a file, so it answers the
 * same on every platform.
 *
 * Built-ins are the names of Node.js's list as Studio commits it (src/lib/provider-host/node-builtins.ts), the same
 * under Node.js and Bun. The two runtime tests judge one set of records in-process under Bun and in a Node.js child
 * bundled from the real module, so a name Bun alone serves as a built-in, such as `ws`, is outside under both. The
 * child needs `node` 24 on PATH. A Windows child ends its lines with CRLF, so the last line of its output is trimmed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closureOutside } from "@/lib/provider-host/provider-closure";
import type { ImportKind, ModuleImport } from "@/lib/provider-host/providers-lock-format";

/** Whether the one import `specifier` of `from`, of `kind`, is outside the package. */
function outside(from: string, specifier: string, kind: ImportKind = "import"): boolean {
  return closureOutside([{ from, specifier, kind }]);
}

const CLOSURE = join(import.meta.dir, "..", "..", "..", "..", "src", "lib", "provider-host", "provider-closure.ts");

/** Names Bun 1.4.4's runtime answers true for as built-ins and Node.js 24's does not. */
const BUN_ONLY = [
  "ws",
  "undici",
  "bun",
  "bun:sqlite",
  "bun:test",
  "bun:ffi",
  "bun:jsc",
  "bun:wrap",
  "node:quic",
  "node:node:test",
];
/** Names of Node.js 24.0.0's built-in list, bare, in their `node:` form, or `node:`-only. */
const NODE_INSIDE = [
  "fs",
  "node:fs",
  "fs/promises",
  "node:test",
  "node:test/reporters",
  "node:sea",
  "node:sqlite",
  "node:_stream_readable",
];
/**
 * The names of Node.js 24.0.0's list that Node.js 26.13.1, the images' release, no longer serves: Node.js 24 serves
 * each bare, so the bare form is a built-in there, and Node.js 26 resolves it as a package through node_modules.
 */
const IMAGES_DROPPED = [
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
];
/** Names no runtime's list admits here: a `node:`-only name bare, a name a later Node.js adds, an unknown one. */
const OUTSIDE_BOTH = ["test", "sea", "test/reporters", "node:ffi", "node:nope"];
/** The built-ins every record below holds. */
const BASE_RECORD = ["fs", "node:fs", "node:test"];
/** The names added one at a time to the base record. */
const ADDED = ["ws", "undici", "bun", "bun:sqlite"];

/** One record of `dist/index.mjs` importing each of `specifiers`. */
function record(specifiers: readonly string[]): ModuleImport[] {
  return specifiers.map((specifier) => ({ from: "dist/index.mjs", specifier, kind: "import" }));
}

/** What the Node.js child reports. */
type NodeReport = {
  version: string;
  answers: Record<string, boolean>;
  nodeBuiltin: Record<string, boolean>;
  base: boolean;
  withAdded: Record<string, boolean>;
};

let dir: string;
let nodeReport: NodeReport;

beforeAll(async () => {
  const node = Bun.which("node");
  if (node === null)
    throw new Error("No Node binary: put Node 24 on PATH, the release package.json engines.node names");
  dir = mkdtempSync(join(tmpdir(), "provider-closure-"));
  const at = (file: string) => join(dir, file);
  const names = [...BUN_ONLY, ...NODE_INSIDE, ...OUTSIDE_BOTH, ...IMAGES_DROPPED];
  writeFileSync(
    at("child.ts"),
    [
      'import { isBuiltin } from "node:module";',
      `import { closureOutside } from ${JSON.stringify(CLOSURE)};`,
      `const names = ${JSON.stringify(names)};`,
      `const base = ${JSON.stringify(BASE_RECORD)};`,
      `const added = ${JSON.stringify(ADDED)};`,
      'const record = (specifiers) => specifiers.map((specifier) => ({ from: "dist/index.mjs", specifier, kind: "import" }));',
      "const report = {",
      "  version: process.version,",
      "  answers: Object.fromEntries(names.map((name) => [name, closureOutside(record([name]))])),",
      "  nodeBuiltin: Object.fromEntries(names.map((name) => [name, isBuiltin(name)])),",
      "  base: closureOutside(record(base)),",
      "  withAdded: Object.fromEntries(added.map((name) => [name, closureOutside(record([...base, name]))])),",
      "};",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  const child = Bun.spawn([node, at("child.js")], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The child ${node} exited ${exitCode}: ${stderr}`);
  nodeReport = JSON.parse(stdout.trim().split("\n").at(-1) as string) as NodeReport;
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the import closure", () => {
  test("a built-in and a relative file inside the artifact are inside, named by an import or a require", () => {
    const inside: [string, string][] = [
      ["dist/index.mjs", "node:fs"],
      ["dist/index.mjs", "fs"],
      ["dist/index.mjs", "fs/promises"],
      ["dist/index.mjs", "node:test"],
      ["dist/index.mjs", "./lib/util.mjs"],
      ["dist/lib/util.mjs", "../index.mjs"],
      ["dist/lib/util.mjs", "../../package.json"],
      ["dist/lib/util.mjs", "."],
      ["dist/lib/util.mjs", ".."],
    ];
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of inside)
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, false]);
    }
    expect(closureOutside([])).toBe(false);
  });

  test("a relative import that leaves the artifact, or holds %, ?, # or a backslash, is outside", () => {
    const cases: [string, string][] = [
      ["dist/index.mjs", "../../outside.mjs"],
      ["dist/lib/util.mjs", "../../.."],
      ["package.json", ".."],
      ["package.json", "../x"],
      ["dist/lib/util.mjs", "./%2e%2e/%2e%2e/%2e%2e/x.mjs"],
      ["dist/index.mjs", "./util.mjs?x"],
      ["dist/index.mjs", "./util.mjs#x"],
      ["dist/index.mjs", ".\\lib\\util.mjs"],
    ];
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of cases)
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, true]);
    }
    // One import outside among others inside refuses the record.
    expect(
      closureOutside([
        { from: "dist/index.mjs", specifier: "./lib/util.mjs", kind: "import" },
        { from: "dist/index.mjs", specifier: "../../x.mjs", kind: "import" },
      ]),
    ).toBe(true);
  });

  test("every bare specifier, named by an import or a require, is outside whatever node_modules folder the package holds", () => {
    // The record alone decides: no listing is read, so a vendored node_modules/<name> folder changes nothing. Bun's ES
    // module resolver, and the CommonJS resolvers of Node.js and Bun, move on past a folder that lacks the file.
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of [
        ["dist/index.mjs", "dep"],
        ["dist/index.mjs", "dep/lib/index.js"],
        ["dist/index.mjs", "near"],
        ["dist/index.mjs", "@scope/pkg"],
        ["dist/index.mjs", "@scope/pkg/index.js"],
        ["dist/index.mjs", "@scope"],
        ["dist/index.mjs", "dep/../../../x"],
        ["dist/index.mjs", ".dep"],
        ["node_modules/dep/lib/index.js", "inner"],
        ["node_modules/dep/lib/index.js", "dep"],
      ] as const) {
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, true]);
      }
    }
  });

  test("an absolute path, a URL, another scheme and a subpath import are outside", () => {
    for (const specifier of [
      "/etc/passwd",
      "file:///etc/passwd",
      "data:text/javascript,export default 1",
      "https://example.invalid/x.mjs",
      "npm:left-pad",
      "node:nope",
      "#internal",
    ]) {
      expect([specifier, outside("dist/index.mjs", specifier)]).toEqual([specifier, true]);
    }
  });

  test("the answer reads only the record, so it is the same on every platform", () => {
    for (const specifier of ["C:\\x.mjs", "C:/x.mjs", "\\\\server\\share\\x.mjs", "\\x.mjs"]) {
      expect([specifier, outside("dist/index.mjs", specifier)]).toEqual([specifier, true]);
    }
    expect(closureOutside([{ from: "a.mjs", specifier: "./a.mjs", kind: "import" }])).toBe(false);
  });

  test("a name only Bun treats as a built-in is outside the closure under every runtime", () => {
    // The premise: Bun's own runtime serves each of these names as a built-in, so a judge asking it would admit them.
    expect(BUN_ONLY.filter((name) => !isBuiltin(name))).toEqual([]);
    for (const kind of ["import", "require"] as const) {
      for (const name of BUN_ONLY)
        expect([kind, name, outside("dist/index.mjs", name, kind)]).toEqual([kind, name, true]);
    }
    expect(BUN_ONLY.filter((name) => !nodeReport.answers[name])).toEqual([]);
    for (const name of ADDED) {
      expect([name, closureOutside(record([...BASE_RECORD, name])), nodeReport.withAdded[name]]).toEqual([
        name,
        true,
        true,
      ]);
    }
  });

  test("a bare name of the list that the images' Node.js no longer serves is outside, its node: form inside", () => {
    // Node.js 26 resolves such a bare name as a package by walking node_modules directories up from the importing file,
    // out of the package, while a node: specifier never resolves through node_modules and fails at the import.
    for (const kind of ["import", "require"] as const) {
      for (const name of IMAGES_DROPPED) {
        expect([kind, name, outside("dist/index.mjs", name, kind)]).toEqual([kind, name, true]);
        expect([kind, name, outside("dist/index.mjs", `node:${name}`, kind)]).toEqual([kind, name, false]);
      }
    }
    expect(IMAGES_DROPPED.filter((name) => !nodeReport.answers[name])).toEqual([]);
    // The premise on the floor: Node.js 24 still serves each bare, so only the list, not that runtime, refuses it.
    expect(IMAGES_DROPPED.filter((name) => !nodeReport.nodeBuiltin[name])).toEqual([]);
  });

  test("the built-in list is Node.js's, the same under Node.js and Bun", () => {
    expect(nodeReport.version.slice(1).split(".")[0]).toBe("24");
    const names = [...BUN_ONLY, ...NODE_INSIDE, ...OUTSIDE_BOTH];
    const expected = Object.fromEntries(names.map((name) => [name, !NODE_INSIDE.includes(name)]));
    const inBun = Object.fromEntries(names.map((name) => [name, outside("dist/index.mjs", name)]));
    const inNode = Object.fromEntries(names.map((name) => [name, nodeReport.answers[name]]));
    expect({ bun: inBun, node: inNode }).toEqual({ bun: expected, node: expected });
    // Node.js's own built-in check agrees on these names: a name is inside exactly when Node.js 24 serves it. The bare
    // names the images' release dropped are the exception, held by the test above.
    const insideByNode = Object.fromEntries(names.map((name) => [name, !nodeReport.nodeBuiltin[name]]));
    expect(inNode).toEqual(insideByNode);
    expect([closureOutside(record(BASE_RECORD)), nodeReport.base]).toEqual([false, false]);
  });
});
