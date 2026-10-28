import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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
