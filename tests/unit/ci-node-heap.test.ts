import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// tsconfig.json includes every TypeScript file in the repository, tests among them, and checking that program peaks
// within tens of MB of Node's default heap of about 4 GB on a GitHub runner: a pull request that added 0.3% more types
// ran out of memory in `tsc --noEmit` and, in another run, in `next build`, whose type check is the same program,
// while main still passed. The release payload build raised its heap for the same reason in #1535
// (scripts/build-standalone-payload.sh). So every CI step that runs that check, through `bun run typecheck`,
// `bun run build` or a Playwright run whose first web server builds, carries the same raise, and a new such step
// without it fails here instead of on a pull request that happens to tip the limit.

const HEAP = "--max-old-space-size=6144";

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

const workflow = parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
};

/** Whether a command type-checks the whole tree: `tsc` through `typecheck`, or `next build`, alone or in Playwright. */
const typeChecksTheTree = (run: string): boolean =>
  /\bbun run (typecheck|build)\b(?!:)/.test(run) ||
  /\bplaywright test\b/.test(run) ||
  /\btest:e2e:base-path\b/.test(run);

const guarded = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
  steps.filter((step) => typeChecksTheTree(step.run ?? "")).map((step) => ({ job, step })),
);

describe("every CI step that type-checks the whole tree runs Node with a 6 GB heap", () => {
  test("finds the type check and the build, so the check below cannot pass empty", () => {
    expect(guarded.map(({ job, step }) => `${job}: ${step.name}`)).toEqual(
      expect.arrayContaining(["lint-and-build: Run TypeScript type check", "lint-and-build: Build project"]),
    );
  });

  test("each of them sets NODE_OPTIONS to the raised heap", () => {
    const missing = guarded
      .filter(({ step }) => !String(step.env?.NODE_OPTIONS ?? "").includes(HEAP))
      .map(({ job, step }) => `${job}: ${step.name}`);
    expect(missing).toEqual([]);
  });
});
