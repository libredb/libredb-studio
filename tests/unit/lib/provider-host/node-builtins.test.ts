/**
 * The built-in list admission judges a package's import record by (src/lib/provider-host/node-builtins.ts): it equals
 * `builtinModules` of Node.js at the release package.json `engines.node` names as its floor, read from Node.js 24.0.0.
 *
 * The test spawns the `node` on PATH, requires its major to be the floor's, and compares its `builtinModules` with the
 * committed list exactly; Node.js 24.0.0 through 24.22.3 return the same names. The child's own built-in check must
 * also agree with the module's predicate on every admitted name and on names only Bun or a later Node.js serves. A
 * failure names each name added or missing, a disagreement, or a floor that moved, and the list is then read again.
 * The names a later release Studio runs on dropped (`NODE_BUILTINS_DROPPED_LATER`) are built-ins of Node.js 24 in both
 * forms and are refused in both, so the child does not judge them; node-builtins-runtimes.test.ts holds every admitted
 * name, in each form, to the images' Node.js.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNodeBuiltin, NODE_BUILTIN_MODULES, NODE_BUILTINS_DROPPED_LATER } from "@/lib/provider-host/node-builtins";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Names judged besides the admitted ones: Bun's own, bare forms of `node:`-only names, a later release's, unknown. */
const PROBES = [
  "ws",
  "undici",
  "bun",
  "bun:sqlite",
  "bun:test",
  "node:quic",
  "node:node:test",
  "test",
  "sea",
  "test/reporters",
  "node:ffi",
  "node:nope",
  "nope",
];

/** The list less the names a later release Studio runs on dropped. */
const SERVED = NODE_BUILTIN_MODULES.filter((name) => !NODE_BUILTINS_DROPPED_LATER.includes(name));

/** Every name the module admits: each name of `SERVED`, and `node:` before each bare name of it. */
const ADMITTED = [...SERVED, ...SERVED.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`)];

/** What the Node.js child reports. */
type NodeReport = { version: string; builtinModules: string[]; disagree: string[] };

let dir: string;
let nodeReport: NodeReport;

beforeAll(async () => {
  const node = Bun.which("node");
  if (node === null)
    throw new Error("No Node binary: put Node 24 on PATH, the release package.json engines.node names");
  dir = mkdtempSync(join(tmpdir(), "node-builtins-"));
  const admitted = new Set(ADMITTED);
  const judged = [...ADMITTED, ...PROBES];
  const expected = Object.fromEntries(judged.map((name) => [name, admitted.has(name)]));
  writeFileSync(
    join(dir, "child.mjs"),
    [
      'import { builtinModules, isBuiltin } from "node:module";',
      `const expected = ${JSON.stringify(expected)};`,
      "const disagree = Object.keys(expected).filter((name) => isBuiltin(name) !== expected[name]).sort();",
      "const report = { version: process.version, builtinModules: [...builtinModules].sort(), disagree };",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const child = Bun.spawn([node, join(dir, "child.mjs")], {
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
  // A Windows child ends its lines with CRLF, so the last line is trimmed before it is parsed.
  nodeReport = JSON.parse(stdout.trim().split("\n").at(-1) as string) as NodeReport;
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Node.js's built-in list", () => {
  test("the committed built-in list equals Node.js's builtinModules at the engines floor", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines: { node: string } };
    expect(manifest.engines.node).toBe(">=24.0.0");
    const committed = new Set(NODE_BUILTIN_MODULES);
    const reported = new Set(nodeReport.builtinModules);
    expect({
      major: nodeReport.version.slice(1).split(".")[0],
      added: nodeReport.builtinModules.filter((name) => !committed.has(name)),
      missing: NODE_BUILTIN_MODULES.filter((name) => !reported.has(name)),
      disagree: nodeReport.disagree,
    }).toEqual({ major: "24", added: [], missing: [], disagree: [] });
    // A closed list is reviewable: sorted, each name once, and the predicate answers it in process as Node.js does. The
    // dropped names are names of the list, closed and sorted, and refused in both forms, bare and `node:`.
    expect({
      listSorted: [...NODE_BUILTIN_MODULES],
      listFrozen: Object.isFrozen(NODE_BUILTIN_MODULES),
      admittedRefused: ADMITTED.filter((name) => !isNodeBuiltin(name)),
      probesAdmitted: PROBES.filter((name) => isNodeBuiltin(name)),
      droppedSorted: [...NODE_BUILTINS_DROPPED_LATER],
      droppedFrozen: Object.isFrozen(NODE_BUILTINS_DROPPED_LATER),
      droppedNotListed: NODE_BUILTINS_DROPPED_LATER.filter((name) => !committed.has(name)),
      droppedAdmitted: NODE_BUILTINS_DROPPED_LATER.flatMap((name) => [name, `node:${name}`]).filter((name) =>
        isNodeBuiltin(name),
      ),
    }).toEqual({
      listSorted: [...committed].sort(),
      listFrozen: true,
      admittedRefused: [],
      probesAdmitted: [],
      droppedSorted: [...new Set(NODE_BUILTINS_DROPPED_LATER)].sort(),
      droppedFrozen: true,
      droppedNotListed: [],
      droppedAdmitted: [],
    });
  });
});
