/**
 * A Node child with a bounded heap and a timeout, for a case that must never run in the test process: one whose
 * regression would loop or allocate without bound (docs/providers/CONTRACT.md, clauses C-1 and C-24).
 *
 * `boundedChild` writes a child module that imports what the case needs from the SDK's TypeScript source, states the
 * case function from its text, runs it with the case name and prints its report as one JSON line. Node loads neither a
 * bun:test file nor the SDK's TypeScript source, so `build` bundles that module with Bun.build({ target: "node" }).
 * `run` spawns the node on PATH under `--max-old-space-size` with a timeout on the spawn, so a child that loops is
 * killed and one that grows dies at the heap limit; either fails its case with its exit and its first line of standard
 * error, within seconds, and never hangs the runner.
 *
 * The case function runs from its text, so it names nothing outside itself and reaches the SDK only through the `deps`
 * record the child builds from its imports. It covers nothing in the test process, by design.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** One module the child imports: the named exports it binds, and its default export's name where it binds one. */
export interface ChildImport {
  readonly from: string;
  readonly names?: readonly string[];
  readonly defaultAs?: string;
}

export interface ChildSpec {
  /** A short name for the temporary directory and the failure message. */
  readonly label: string;
  /** What the child imports; every bound name is a member of the `deps` record the case receives. */
  readonly imports: readonly ChildImport[];
  /** The case, run from its text with the `deps` record and the case name, answering a JSON value. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each file types its own deps; the child passes them by text.
  readonly runCase: (deps: any, name: string) => unknown;
  /** The old space the child may use, in MiB. */
  readonly heapLimitMiB: number;
  /** How long the child may run before the spawn kills it. */
  readonly timeoutMs: number;
}

export interface BoundedChild {
  /** Writes and bundles the child; call once, in `beforeAll`. */
  build(): Promise<void>;
  /** Runs one case in a fresh child and answers its report. */
  run<Report>(name: string): Promise<Report>;
  /** Removes the child's temporary directory; call in `afterAll`. */
  remove(): void;
}

/** The node on PATH; no node fails by name. */
function nodeBinary(label: string): string {
  const onPath = Bun.which("node");
  if (onPath === null) throw new Error(`No node on PATH: ${label} runs its cases under Node; install Node 24`);
  return onPath;
}

/** The import line of `item`. */
function importLine(item: ChildImport): string {
  const clauses = [
    ...(item.defaultAs === undefined ? [] : [item.defaultAs]),
    ...(item.names === undefined ? [] : [`{ ${item.names.join(", ")} }`]),
  ];
  return `import ${clauses.join(", ")} from ${JSON.stringify(item.from)};`;
}

export function boundedChild(spec: ChildSpec): BoundedChild {
  const dir = mkdtempSync(path.join(tmpdir(), `provider-sdk-${spec.label}-`));
  const bound = spec.imports.flatMap((item) => [
    ...(item.defaultAs === undefined ? [] : [item.defaultAs]),
    ...(item.names ?? []),
  ]);
  return {
    async build(): Promise<void> {
      writeFileSync(
        path.join(dir, "child.ts"),
        [
          ...spec.imports.map(importLine),
          `const runCase = ${spec.runCase.toString()};`,
          `const report = await runCase({ ${bound.join(", ")} }, process.argv[2]);`,
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
    },

    async run<Report>(name: string): Promise<Report> {
      const child = Bun.spawn(
        [nodeBinary(spec.label), `--max-old-space-size=${spec.heapLimitMiB}`, path.join(dir, "child.js"), name],
        { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: spec.timeoutMs },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0 || child.signalCode !== null) {
        const first = stderr.split("\n").find((line) => line.includes("FATAL")) ?? stderr.trim().split("\n")[0];
        throw new Error(`The ${name} child exited ${exitCode} (signal ${child.signalCode}): ${first}`);
      }
      return JSON.parse(stdout.trim().split("\n").at(-1) as string) as Report;
    },

    remove(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
