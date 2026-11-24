/**
 * The result pump cannot be pulled forever (docs/providers/CONTRACT.md, clause C-15), proven where a failure is bounded.
 *
 * A pump without its guards would pull a source that never progresses forever, or hold the rows of a source that
 * never ends until the heap is gone. So neither case runs in this process: each runs in a Node child, as production
 * runs Studio, with the old space limited to `HEAP_LIMIT_MIB` and a timeout on the spawn, and prints one JSON line. A
 * child that times out or exits non-zero fails its case with its exit and its first line of standard error, so a
 * regression fails within seconds and never hangs the runner.
 *
 * The child runs a bundle that Bun.build({ target: "node" }) makes of the SDK's calls entry around the text of
 * `runCase`, as tests/unit/db/databend/wire-heap.test.ts runs its cases. The child is the node on PATH, so CI's legs
 * run it on every platform. It covers nothing in this process, by design: every pump line it reaches, results.test.ts
 * reaches in process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BATCH_MAX_BYTES, CallRefusalError, pumpPage, ResultSource, RowBatch } from "@libredb/provider-sdk/calls";

/** The old space each child may use: far less than a page of rows held without its byte cut would need. */
const HEAP_LIMIT_MIB = 64;
/** How long a child may run: the cases take well under a second, and a child pulled forever is killed here. */
const CHILD_TIMEOUT_MS = 20_000;

interface ChildDeps {
  readonly pumpPage: typeof pumpPage;
  readonly BATCH_MAX_BYTES: typeof BATCH_MAX_BYTES;
}

interface ChildReport {
  readonly name: string;
  readonly rule?: string;
  readonly end?: string;
  readonly rows?: number;
  readonly bytes?: number;
  readonly pulls: number;
}

/**
 * Runs in the child, from its text, so it names nothing outside itself: one page pumped from a source that never
 * progresses, or from one that never ends.
 */
async function runCase(deps: ChildDeps, name: string): Promise<ChildReport> {
  let pulls = 0;
  const answers: Record<string, () => RowBatch> = {
    "never-progresses": () => ({ rows: [], done: false }),
    // A fresh row of 1 KiB each pull, so a page held without its byte cut grows the heap by its rows' text.
    "never-ends": () => ({ rows: [["k".repeat(1024 - 4)]], done: false }),
  };
  const answer = answers[name];
  const source: ResultSource = {
    columns: [{ name: "k" }],
    async next() {
      pulls += 1;
      return answer();
    },
    async close() {},
  };
  try {
    const page = await deps.pumpPage(
      source,
      {
        maxRows: Number.MAX_SAFE_INTEGER,
        maxBytes: deps.BATCH_MAX_BYTES,
        batchMaxBytes: deps.BATCH_MAX_BYTES,
      },
      { deadline: Date.now() + 3_600_000, signal: new AbortController().signal },
    );
    return { name, end: page.end, rows: page.rows.length, bytes: page.bytes, pulls };
  } catch (error) {
    return { name, rule: (error as CallRefusalError).refusals?.[0]?.rule ?? String(error), pulls };
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "provider-sdk-pump-bounds-"));
const CALLS_ENTRY = path.join(import.meta.dir, "..", "..", "src", "calls", "index.ts");

beforeAll(async () => {
  // Node loads neither this bun:test file nor the SDK's TypeScript source, so the child is a bundle.
  writeFileSync(
    path.join(dir, "child.ts"),
    [
      `import { BATCH_MAX_BYTES, pumpPage } from ${JSON.stringify(CALLS_ENTRY)};`,
      `const runCase = ${runCase.toString()};`,
      "const report = await runCase({ pumpPage, BATCH_MAX_BYTES }, process.argv[2]);",
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
  if (onPath === null) throw new Error("No node on PATH: this file bounds the pump under Node; install Node 24");
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

describe(`the pump in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test("a source that never progresses is refused after one pull, in a bounded child", async () => {
    expect(await runChild("never-progresses")).toEqual({
      name: "never-progresses",
      rule: "batch-empty-not-done",
      pulls: 1,
    });
  }, 30_000);

  test("a source that never ends is cut at the page's byte budget, in a bounded child", async () => {
    expect(await runChild("never-ends")).toEqual({
      name: "never-ends",
      end: "byte-limit",
      rows: 1024,
      bytes: 1024 * 1024,
      pulls: 1024,
    });
  }, 30_000);
});
