import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { posixShell, testIf } from "../helpers/posix-tools";

// tsconfig.json includes every TypeScript file in the repository, tests among them, and checking that program peaks
// within tens of MB of Node's default heap of about 4 GB on a GitHub runner: a pull request that added 0.3% more types
// ran out of memory in `tsc --noEmit` and, in another run, in `next build`, whose type check is the same program,
// while main still passed. The release payload build raised its heap for the same reason in #1535
// (scripts/build-standalone-payload.sh). So every step of every workflow that runs that check, through
// `bun run typecheck`, `bun run build` or a Playwright run whose first web server builds, carries the same raise, and a
// new such step without it fails here instead of on a pull request, an image build or a release that happens to tip
// the limit: the image workflow's type check ran out of memory on main once ci.yml's had been raised alone.

const HEAP = "--max-old-space-size=6144";

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly env?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<
    Record<string, { readonly env?: Readonly<Record<string, unknown>>; readonly steps?: readonly Step[] }>
  >;
}

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");

/** Whether a command type-checks the whole tree: `tsc` through `typecheck`, or `next build`, alone or in Playwright. */
const typeChecksTheTree = (run: string): boolean =>
  /\bbun run (typecheck|build)\b(?!:)/.test(run) ||
  /\bplaywright test\b/.test(run) ||
  /\btest:e2e:base-path\b/.test(run);

/** Each such step of every workflow, with the NODE_OPTIONS it runs under: its own, else its job's, else the workflow's. */
const guarded = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .flatMap((file) => {
    const workflow = parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
    return Object.entries(workflow.jobs ?? {}).flatMap(([job, { env, steps = [] }]) =>
      steps
        .filter((step) => typeChecksTheTree(step.run ?? ""))
        .map((step) => ({
          where: `${file} ${job}: ${step.name}`,
          nodeOptions: String(step.env?.NODE_OPTIONS ?? env?.NODE_OPTIONS ?? workflow.env?.NODE_OPTIONS ?? ""),
        })),
    );
  });

describe("every CI step that type-checks the whole tree runs Node with a 6 GB heap", () => {
  test("finds the type checks and the builds of every workflow, so the check below cannot pass empty", () => {
    expect(guarded.map(({ where }) => where)).toEqual(
      expect.arrayContaining([
        "ci.yml lint-and-build: Run TypeScript type check",
        "ci.yml lint-and-build: Build project",
        "docker-build-push.yml prepare: Run TypeScript type check",
        "npm-publish.yml validate: Typecheck",
        "npm-publish.yml validate: Build",
      ]),
    );
  });

  test("each of them sets NODE_OPTIONS to the raised heap", () => {
    const missing = guarded.filter(({ nodeOptions }) => !nodeOptions.includes(HEAP)).map(({ where }) => where);
    expect(missing).toEqual([]);
  });
});

// The same check outgrows the default heap on a workstation too, whenever it runs cold: a fresh clone or worktree, or
// a change that invalidates most of tsconfig.tsbuildinfo, aborted `tsc --noEmit` at about 4.07 GB against a 4288 MiB
// default, while the warm incremental run that follows passes and makes the first failure look flaky. So the scripts
// raise the heap themselves, through NODE_OPTIONS because `next build` type-checks in a worker that takes its heap from
// NODE_OPTIONS (node_modules/next/dist/lib/worker.js), with the caller's own NODE_OPTIONS after it so a caller can still
// choose a larger heap. `bun run` runs scripts in the system shell on POSIX and in Bun's own shell on Windows, the
// documented default of Bun's `run.shell` setting, which this repo's bunfig.toml does not change, so the prefix is
// proven in both.

const SCRIPTS = (
  JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The NODE_OPTIONS assignment that prefixes `command` inside a package.json script, or "" when there is none. */
const heapPrefix = (script: string, command: string): string =>
  new RegExp(`(NODE_OPTIONS="[^"]*") ${command}`).exec(script)?.[1] ?? "";

const LOCAL = [
  { script: "typecheck", command: "tsc --noEmit" },
  { script: "build", command: "next build" },
] as const;

const PRINT_HEAP_MIB = `node -p "Math.round(v8.getHeapStatistics().heap_size_limit / 2 ** 20)"`;

/** The process environment without NODE_OPTIONS, plus `nodeOptions` when given. */
const envWith = (nodeOptions?: string): Record<string, string> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.NODE_OPTIONS;
  return nodeOptions === undefined ? env : { ...env, NODE_OPTIONS: nodeOptions };
};

const heapUnderBunShell = async (command: string, env: Record<string, string>): Promise<number> =>
  Number((await Bun.$`${{ raw: command }}`.env(env).quiet().text()).trim());

// On Windows `bun run` never hands a script to sh, and a bare `sh` is not on a PowerShell PATH there
// (tests/helpers/posix-tools.ts), so the system-shell leg runs only where it is the shell scripts run in.
const SYSTEM_SHELL = process.platform === "win32" ? null : posixShell("sh");
const MISSING_SYSTEM_SHELL: string | null =
  process.platform === "win32"
    ? "system shell: on Windows `bun run` runs scripts in Bun's own shell, which the other leg covers"
    : SYSTEM_SHELL === null
      ? "no POSIX sh on PATH"
      : null;

const heapUnderSystemShell = (command: string, env: Record<string, string>): number => {
  const run = Bun.spawnSync([SYSTEM_SHELL ?? "sh", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  return Number(run.stdout.toString().trim());
};

describe("the typecheck and build scripts raise the heap themselves, so a cold local run does not need CI's env", () => {
  for (const { script, command } of LOCAL) {
    test(`${script} runs \`${command}\` with the raised heap first and the caller's NODE_OPTIONS after it`, () => {
      expect(heapPrefix(SCRIPTS[script] ?? "", command)).toBe(`NODE_OPTIONS="${HEAP} $NODE_OPTIONS"`);
    });

    const probe = `${heapPrefix(SCRIPTS[script] ?? "", command)} ${PRINT_HEAP_MIB}`;

    test(`${script}'s prefix gives Node the raised heap under Bun's shell`, async () => {
      expect(await heapUnderBunShell(probe, envWith())).toBeGreaterThanOrEqual(6144);
      expect(await heapUnderBunShell(probe, envWith("--max-old-space-size=8192"))).toBeGreaterThanOrEqual(8192);
      expect(await heapUnderBunShell(probe, envWith("--max-old-space-size=8192"))).toBeLessThan(8192 + 1024);
    });

    testIf(MISSING_SYSTEM_SHELL, `${script}'s prefix gives Node the raised heap under the system shell`, () => {
      expect(heapUnderSystemShell(probe, envWith())).toBeGreaterThanOrEqual(6144);
      expect(heapUnderSystemShell(probe, envWith("--max-old-space-size=8192"))).toBeGreaterThanOrEqual(8192);
      expect(heapUnderSystemShell(probe, envWith("--max-old-space-size=8192"))).toBeLessThan(8192 + 1024);
    });
  }
});
