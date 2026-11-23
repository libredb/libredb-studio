/**
 * An honours list a package answers is refused by its length before any item is read (docs/providers/CONTRACT.md,
 * clauses C-1 and C-10), proven where a failure is bounded.
 *
 * A check that walked a list to its `length` would loop over a sparse array of length 2^32 - 1 and push a refusal per
 * hole until the heap is gone. So neither case runs in this process: each runs in a Node child, as production runs
 * Studio, with the old space limited to `HEAP_LIMIT_MIB` and a timeout on the spawn, and prints one JSON line. A child
 * that times out or exits non-zero fails its case with its exit and its first line of standard error, so a regression
 * fails within seconds and never hangs the runner.
 *
 * The child runs a bundle that Bun.build({ target: "node" }) makes of the SDK's calls entry around the text of
 * `runCase`, as pump-bounds.test.ts runs its cases. It covers nothing in this process, by design: every line it
 * reaches, refinement.test.ts and define-provider.test.ts reach in process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallRefusal, checkProviderModule, checkRefinement, DefinitionRefusal } from "@libredb/provider-sdk/calls";

/** The old space each child may use: far less than a refusal per hole of the longest array would need. */
const HEAP_LIMIT_MIB = 64;
/** How long a child may run: the cases take well under a second, and a child that loops is killed here. */
const CHILD_TIMEOUT_MS = 20_000;

interface ChildDeps {
  readonly checkProviderModule: typeof checkProviderModule;
  readonly checkRefinement: typeof checkRefinement;
  readonly manifest: Record<string, unknown>;
}

interface ChildReport {
  readonly name: string;
  readonly refusals: readonly (CallRefusal | DefinitionRefusal)[];
}

/**
 * Runs in the child, from its text, so it names nothing outside itself: a refinement or a manifest whose honours list
 * is a sparse array of the longest length an array can have. Only the refusals of that list are reported.
 */
function runCase(deps: ChildDeps, name: string): ChildReport {
  const longest: unknown[] = [];
  longest.length = 2 ** 32 - 1;
  if (name === "refinement") {
    const declared = {
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "offered",
        endScope: "offered",
        transaction: "offered",
      },
    };
    const refine = { calls: { console: { execute: { honours: longest } } } };
    return { name, refusals: deps.checkRefinement(declared as never, refine) };
  }
  const manifest = JSON.parse(JSON.stringify(deps.manifest));
  manifest.calls.console.execute.honours = longest;
  const impl = { open: async () => ({ handle: {} }), close: async () => {}, console: { execute: async () => ({}) } };
  const refusals = deps.checkProviderModule({ contract: "0.1", manifest, impl });
  return { name, refusals: refusals.filter((item) => item.pointer.startsWith("/manifest/calls/console/execute")) };
}

const dir = mkdtempSync(path.join(tmpdir(), "provider-sdk-honours-bounds-"));
const CALLS_ENTRY = path.join(import.meta.dir, "..", "..", "src", "calls", "index.ts");
const MANIFEST = path.join(import.meta.dir, "..", "fixtures", "minimal-manifest.json");

beforeAll(async () => {
  // Node loads neither this bun:test file nor the SDK's TypeScript source, so the child is a bundle.
  writeFileSync(
    path.join(dir, "child.ts"),
    [
      `import { checkProviderModule, checkRefinement } from ${JSON.stringify(CALLS_ENTRY)};`,
      `import manifest from ${JSON.stringify(MANIFEST)};`,
      `const runCase = ${runCase.toString()};`,
      "const report = runCase({ checkProviderModule, checkRefinement, manifest }, process.argv[2]);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({
    entrypoints: [path.join(dir, "child.ts")],
    target: "node",
    format: "esm",
    outdir: dir,
  });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The node on PATH; no node fails by name. */
function nodeBinary(): string {
  const onPath = Bun.which("node");
  if (onPath === null)
    throw new Error("No node on PATH: this file bounds the honours checks under Node; install Node 24");
  return onPath;
}

async function runChild(name: string): Promise<ChildReport> {
  const child = Bun.spawn([nodeBinary(), `--max-old-space-size=${HEAP_LIMIT_MIB}`, path.join(dir, "child.js"), name], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || child.signalCode !== null) {
    const first = stderr.split("\n").find((line) => line.includes("FATAL")) ?? stderr.trim().split("\n")[0];
    throw new Error(`The ${name} child exited ${exitCode} (signal ${child.signalCode}): ${first}`);
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as ChildReport;
}

describe(`the honours checks in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test("a refinement honours list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await runChild("refinement")).toEqual({
      name: "refinement",
      refusals: [{ rule: "refinement-widens", pointer: "/calls/console/execute/honours" }],
    });
  }, 30_000);

  test("a manifest honours list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await runChild("module")).toEqual({
      name: "module",
      refusals: [{ rule: "manifest-unreadable", pointer: "/manifest/calls/console/execute/honours" }],
    });
  }, 30_000);
});
