/**
 * A Node child with a bounded heap and a spawn timeout, for a case that must never run in the test process: one whose
 * regression would hang or allocate without bound (the host core's waits and deadlines, src/lib/provider-host/core).
 *
 * The SDK keeps a helper of the same shape for its own tests (packages/provider-sdk/tests/helpers/node-child.ts), and
 * Studio's tests never reach into a package by path (tests/unit/package-imports.test.ts), so Studio's tests keep this
 * one.
 *
 * `boundedChild` writes a child module that imports what the case needs from Studio's TypeScript source by absolute
 * path, states the case function from its text, runs it with the case name and prints its report as one JSON line.
 * Node loads neither a bun:test file nor TypeScript with `@/` imports, so `build` bundles that module with
 * Bun.build({ target: "node" }). The child holds a referenced interval while the case runs, so a case waiting on a
 * promise nothing settles keeps the child alive until the spawn timeout kills it, instead of letting Node exit early with
 * an unsettled top-level await. `run` spawns the node on PATH under `--max-old-space-size` with a timeout on the spawn,
 * so a child that hangs is killed and one that grows dies at the heap limit; either fails its case with its exit and the
 * first line of its standard error, within seconds.
 *
 * The case function runs from its text, so it names nothing outside itself and reaches its imports only through the
 * `deps` record the child builds. It covers nothing in the test process, by design.
 *
 * A module whose real import cannot load under Node (one that reaches a native addon, as the provider factory reaches
 * ssh2's) is stubbed: each entry of `stubs` is written into the child's temporary directory, and a Bun.build plugin
 * resolves exactly its specifier to that file, so the child bundles the module under test with the stub in its place.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A module the child's bundle takes in place of the real one: every import of exactly `specifier` reads `source`. */
export interface ChildStub {
  readonly specifier: string;
  readonly source: string;
}

/** One module the child imports, by absolute path, and the named exports it binds. */
export interface ChildImport {
  readonly from: string;
  readonly names: readonly string[];
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
  /** The modules the bundle takes in place of the real ones, by exact specifier; none when left out. */
  readonly stubs?: readonly ChildStub[];
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

export function boundedChild(spec: ChildSpec): BoundedChild {
  const dir = mkdtempSync(path.join(tmpdir(), `studio-${spec.label}-`));
  const bound = spec.imports.flatMap((item) => item.names);
  return {
    async build(): Promise<void> {
      writeFileSync(
        path.join(dir, "child.ts"),
        [
          ...spec.imports.map((item) => `import { ${item.names.join(", ")} } from ${JSON.stringify(item.from)};`),
          `const runCase = ${spec.runCase.toString()};`,
          "const alive = setInterval(() => {}, 1_000);",
          `const report = await runCase({ ${bound.join(", ")} }, process.argv[2]);`,
          "clearInterval(alive);",
          'process.stdout.write(JSON.stringify(report) + "\\n");',
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      const stubs = (spec.stubs ?? []).map((stub, index) => {
        const file = path.join(dir, `stub-${index}.ts`);
        writeFileSync(file, stub.source);
        return { specifier: stub.specifier, file };
      });
      const build = await Bun.build({
        entrypoints: [path.join(dir, "child.ts")],
        target: "node",
        format: "esm",
        outdir: dir,
        plugins: [
          {
            name: "bounded-child-stubs",
            setup(builder) {
              for (const stub of stubs) {
                const exactly = new RegExp(`^${stub.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
                builder.onResolve({ filter: exactly }, () => ({ path: stub.file }));
              }
            },
          },
        ],
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
