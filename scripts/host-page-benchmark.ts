/**
 * The host page benchmark (docs/TOOLCHAIN.md, "The host page benchmark"): P-21's cases rerun through the provider
 * host's in-process path, checked against the owner-signed thresholds T1 to T5.
 *
 * Run as `bun run bench:host-page [-- --node <path>]`, never by `bun run test`: its timings hold only on an idle
 * reference machine, not on a shared runner. It bundles the case module (scripts/host-page-benchmark/case.ts) with
 * `Bun.build` into a temporary directory under `node_modules/.cache`, so Node resolves the bundle's external packages from
 * the repository's own `node_modules`: Studio's `@/` paths and the workspace packages are bundled from source, and
 * every other package stays external. It then runs one fresh Node child per case and path, one at a time, under
 * `--expose-gc --max-old-space-size=3000` with a 300 s timeout, and reads each child's one JSON line.
 *
 * It prints the machine, the runtime, every case and a pass or fail per threshold, and exits 1 when any threshold
 * fails or any case failed. A failed threshold is the owner's decision under AM-1, never a silent change.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BunPlugin } from "bun";
import { workspacePackageSourcePaths } from "./workspace-packages.mjs";
import type { BenchPath, CaseReport, RowCount, Shape } from "./host-page-benchmark/case";

const ROOT = path.resolve(import.meta.dir, "..");
const CASE_MODULE = path.join(ROOT, "scripts", "host-page-benchmark", "case.ts");
const CHILD_TIMEOUT_MS = 300_000;
const SHAPES: readonly Shape[] = ["narrow", "wide"];
const ROWS: readonly RowCount[] = ["50", "500", "10000", "100000", "max"];
const PATHS: readonly BenchPath[] = ["today", "host"];

/** The owner-signed thresholds (P-21, signed 2026-11-23): milliseconds, except T5 in MiB. */
export const THRESHOLDS = Object.freeze({
  /** Added time per 10,000 wide rows. */
  T1: 150,
  /** Added time at the largest page the UI asks for: 100,000 narrow rows, and the 32 MiB wide page. */
  T2: 250,
  /** Added time at a 32 MiB page, either shape. */
  T3: 600,
  /** The longest event-loop slice while the host's execute call runs, every case. */
  T4: 50,
  /** The live heap the host path adds at a 32 MiB page, either shape. */
  T5: 160,
});

/** Resolves `@/` to Studio's source and each workspace package's exports to its source file, so both are bundled. */
function sourcePlugin(): BunPlugin {
  const packages = workspacePackageSourcePaths(ROOT) as Record<string, string[]>;
  return {
    name: "studio-source",
    setup(context) {
      context.onResolve({ filter: /^@\// }, (args) => ({
        path: Bun.resolveSync(`./${args.path.slice(2)}`, path.join(ROOT, "src")),
      }));
      context.onResolve({ filter: /^@libredb\/provider-sdk/ }, (args) => {
        const target = packages[args.path]?.[0];
        if (target === undefined) throw new Error(`No workspace export for ${args.path}.`);
        return { path: path.join(ROOT, target) };
      });
    },
  };
}

/** The case module bundled with a child entry that runs one case, in `directory`; answers the entry's path. */
async function bundle(directory: string): Promise<string> {
  const entry = path.join(directory, "child.ts");
  writeFileSync(
    entry,
    [
      `import { runCase } from ${JSON.stringify(CASE_MODULE)};`,
      "const report = await runCase(process.argv.slice(2));",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: directory,
    naming: "child.mjs",
    target: "node",
    format: "esm",
    packages: "external",
    plugins: [sourcePlugin()],
  });
  if (!built.success) throw new AggregateError(built.logs, "Bundling the benchmark's case module failed.");
  const outfile = path.join(directory, "child.mjs");
  return outfile;
}

type Outcome = { readonly ok: true; readonly report: CaseReport } | { readonly ok: false; readonly failure: string };

/** One case in a fresh Node child. */
function runChild(node: string, child: string, shape: Shape, rows: RowCount, benchPath: BenchPath): Outcome {
  const spawned = spawnSync(
    node,
    ["--expose-gc", "--max-old-space-size=3000", child, "--shape", shape, "--rows", rows, "--path", benchPath],
    { cwd: ROOT, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, maxBuffer: 1 << 20 },
  );
  if (spawned.status !== 0) {
    const reason = spawned.error?.message ?? `exit ${spawned.status} (signal ${spawned.signal})`;
    return { ok: false, failure: `${reason}: ${(spawned.stderr ?? "").trim().split("\n")[0] ?? ""}` };
  }
  return { ok: true, report: JSON.parse(spawned.stdout.trim().split("\n").at(-1) as string) as CaseReport };
}

/** One threshold's verdict: what it reads, its limit and whether every reading is within it. */
interface Verdict {
  readonly id: keyof typeof THRESHOLDS;
  readonly reads: string;
  readonly value: number;
  readonly pass: boolean;
}

/** The verdicts of T1 to T5 over `reports`, keyed `shape rows path`; a missing case fails its threshold. */
export function verdicts(reports: ReadonlyMap<string, CaseReport>): Verdict[] {
  const added = (shape: Shape, rows: RowCount) => {
    const host = reports.get(`${shape} ${rows} host`);
    const today = reports.get(`${shape} ${rows} today`);
    return host === undefined || today === undefined ? Number.POSITIVE_INFINITY : host.medianMs - today.medianMs;
  };
  const heap = (shape: Shape) => reports.get(`${shape} max host`)?.heapAddedMiB ?? Number.POSITIVE_INFINITY;
  const hostReports = [...reports.values()].filter((report) => report.path === "host");
  const slice =
    hostReports.length === SHAPES.length * ROWS.length
      ? Math.max(...hostReports.map((report) => report.sliceMaxMs))
      : Number.POSITIVE_INFINITY;
  const readings: [Verdict["id"], string, number][] = [
    ["T1", "wide 10000 added median ms", added("wide", "10000")],
    ["T2", "narrow 100000 added median ms", added("narrow", "100000")],
    ["T2", "wide max added median ms", added("wide", "max")],
    ["T3", "narrow max added median ms", added("narrow", "max")],
    ["T3", "wide max added median ms", added("wide", "max")],
    ["T4", "longest execute slice ms, every host case", slice],
    ["T5", "narrow max host heap added MiB", heap("narrow")],
    ["T5", "wide max host heap added MiB", heap("wide")],
  ];
  return readings.map(([id, reads, value]) => ({ id, reads, value, pass: value <= THRESHOLDS[id] }));
}

async function main(argv: readonly string[]): Promise<number> {
  const nodeAt = argv.indexOf("--node");
  const node = nodeAt === -1 ? "node" : (argv[nodeAt + 1] as string);
  const cache = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "host-page-benchmark-"));
  try {
    const child = await bundle(directory);
    const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim();
    const cpus = os.cpus();
    console.log(
      `machine: ${cpus[0]?.model ?? "unknown CPU"}, ${cpus.length} logical CPUs, ${os.type()} ${os.release()}`,
    );
    console.log(`runtime: node ${version} (${node})`);
    const reports = new Map<string, CaseReport>();
    const failures: string[] = [];
    for (const shape of SHAPES) {
      for (const rows of ROWS) {
        for (const benchPath of PATHS) {
          const outcome = runChild(node, child, shape, rows, benchPath);
          const key = `${shape} ${rows} ${benchPath}`;
          if (outcome.ok) {
            reports.set(key, outcome.report);
            const { report } = outcome;
            console.log(
              `${key}: ${report.rows} rows, ${report.answerBytes} answer bytes, median ${report.medianMs.toFixed(2)} ms, p95 ${report.p95Ms.toFixed(2)} ms, heap added ${report.heapAddedMiB.toFixed(1)} MiB, slice ${report.sliceMaxMs.toFixed(2)} ms`,
            );
          } else {
            failures.push(`${key}: ${outcome.failure}`);
            console.log(`${key}: FAILED ${outcome.failure}`);
          }
        }
      }
    }
    const results = verdicts(reports);
    for (const verdict of results) {
      console.log(
        `${verdict.id} ${verdict.pass ? "pass" : "FAIL"}: ${verdict.reads} ${verdict.value.toFixed(2)} of at most ${THRESHOLDS[verdict.id]}`,
      );
    }
    return failures.length === 0 && results.every((verdict) => verdict.pass) ? 0 : 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
