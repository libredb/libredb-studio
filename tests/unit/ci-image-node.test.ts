import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// The `Unit & Integration Tests` job runs the runtime-sensitive cases (the byte transport, the S3 client wire, the
// RabbitMQ and MQTT dials, the Snowflake key intake) once more on the Node release the image ships. That release used to
// be a literal in ci.yml, which said it was the Dockerfile's runner stage: it stayed at 26.10.0 from #1696 on while
// Dependabot moved the image through 26.11.1, 26.12.0, 26.12.1 and 26.13.0, because Dependabot reads the Dockerfiles and
// not a workflow's setup-node input. So the job now reads the version from the Dockerfiles when it runs, and this file
// holds that wiring: the step's own shell is run here against copies of the Dockerfiles, so a reader that stops
// matching the runner stage, or stops refusing two images that disagree, fails here and not on a Dependabot pull request.

const ROOT = join(import.meta.dir, "../..");

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

const STEPS = (
  parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: { test: { steps: readonly Step[] } };
  }
).jobs.test.steps;

const READ = STEPS.find((step) => step.id === "image-node");
const RUNTIME_FILES = [
  "tests/unit/db/http/node-transport-runtimes.test.ts",
  "tests/unit/db/s3/client-wire.test.ts",
  "tests/unit/db/rabbitmq/dial-runtimes.test.ts",
  "tests/unit/db/mqtt/dial-runtimes.test.ts",
  "tests/unit/db/snowflake/key-runtimes.test.ts",
];

/** The Node release a Dockerfile's runner stage names, read here independently of the step's own reader. */
function runnerNode(dockerfile: string): string {
  const match = readFileSync(join(ROOT, dockerfile), "utf8").match(/^FROM node:(\d+\.\d+\.\d+)-\S+ AS runner$/m);
  if (!match) throw new Error(`${dockerfile} has no node runner stage`);
  return match[1];
}

const scratch = mkdtempSync(join(tmpdir(), "ci-image-node-"));
let runs = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the step's shell in a directory holding these Dockerfiles, as Actions runs it: bash -e, GITHUB_OUTPUT set. */
function readStep(files: Readonly<Record<string, string>>): { code: number; output: string; log: string } {
  const dir = join(scratch, String(runs++));
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const out = join(dir, "github-output");
  writeFileSync(out, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, READ?.run ?? "exit 99");
  const child = Bun.spawnSync(["bash", "-e", script], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_OUTPUT: out },
  });
  return {
    code: child.exitCode,
    output: readFileSync(out, "utf8"),
    log: `${child.stdout.toString()}${child.stderr.toString()}`,
  };
}

const repoFile = (name: string): string => readFileSync(join(ROOT, name), "utf8");

describe("CI runs the runtime cases on the Node release the image ships", () => {
  test("the two Node images of the repository name one Node release for their runner stage", () => {
    expect(runnerNode("Dockerfile.alpine")).toBe(runnerNode("Dockerfile"));
  });

  test("a step with an id reads that release from the Dockerfiles, in bash", () => {
    expect(READ?.run).toContain("Dockerfile");
    expect(READ?.run).toContain("Dockerfile.alpine");
    expect(READ?.shell).toBe("bash");
  });

  test("on the repository's Dockerfiles the step outputs the runner stage's release", () => {
    const run = readStep({ Dockerfile: repoFile("Dockerfile"), "Dockerfile.alpine": repoFile("Dockerfile.alpine") });
    expect(run).toMatchObject({ code: 0, output: `version=${runnerNode("Dockerfile")}\n` });
  });

  test("the step fails, and says why, when Dockerfile.alpine's runner names another release", () => {
    const debian = runnerNode("Dockerfile");
    const alpine = repoFile("Dockerfile.alpine").replace(
      new RegExp(`^FROM node:${debian.replaceAll(".", "\\.")}-(\\S+) AS runner$`, "m"),
      "FROM node:26.0.0-$1 AS runner",
    );
    expect(alpine).not.toBe(repoFile("Dockerfile.alpine"));
    const run = readStep({ Dockerfile: repoFile("Dockerfile"), "Dockerfile.alpine": alpine });
    expect(run.code).not.toBe(0);
    expect(run.output).toBe("");
    expect(run.log).toContain("::error file=Dockerfile.alpine::");
    expect(run.log).toContain(`26.0.0`);
    expect(run.log).toContain(debian);
  });

  test("the step fails when the Dockerfile's runner stage names no exact Node release", () => {
    for (const from of [
      "FROM node:26-trixie-slim AS runner",
      "FROM node:lts-trixie-slim AS runner",
      "FROM debian AS runner",
    ]) {
      const dockerfile = repoFile("Dockerfile").replace(/^FROM node:\S+ AS runner$/m, from);
      const run = readStep({ Dockerfile: dockerfile, "Dockerfile.alpine": dockerfile });
      expect({ from, code: run.code === 0, output: run.output }).toEqual({ from, code: false, output: "" });
      expect(run.log).toContain("::error file=Dockerfile::");
    }
  });

  test("the step fails when the Dockerfile names two runner stages", () => {
    // Dockerfile.alpine gets the same second stage, so the two images agree and only the exact-release guard can fail it.
    const dockerfile = `${repoFile("Dockerfile")}\nFROM node:26.0.0-trixie-slim AS runner\n`;
    const alpine = `${repoFile("Dockerfile.alpine")}\nFROM node:26.0.0-alpine3.23 AS runner\n`;
    const run = readStep({ Dockerfile: dockerfile, "Dockerfile.alpine": alpine });
    expect(run.code).not.toBe(0);
    expect(run.output).toBe("");
    expect(run.log).toContain("::error file=Dockerfile::");
  });

  test("setup-node installs the release the step read, pinned by commit", () => {
    const setup = STEPS.find(
      (step) =>
        step.uses?.startsWith("actions/setup-node@") &&
        step.with?.["node-version"] === "${{ steps.image-node.outputs.version }}",
    );
    expect(setup?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(STEPS.indexOf(setup as Step)).toBeGreaterThan(STEPS.indexOf(READ as Step));
  });

  test("no setup-node step of the job writes a Node 26 release by hand", () => {
    const literal = STEPS.filter((step) => step.uses?.startsWith("actions/setup-node@")).map((step) =>
      String(step.with?.["node-version"]),
    );
    expect(literal.filter((version) => version.startsWith("26"))).toEqual([]);
  });

  test("the runtime step checks that node reports the release read, then runs every runtime file under that node", () => {
    const runtime = STEPS.find(
      (step) => step.name?.includes("on the image's Node") && step.run?.includes("NODE_TRANSPORT_NODES"),
    );
    expect(runtime?.env?.IMAGE_NODE).toBe("${{ steps.image-node.outputs.version }}");
    const [check, command] = (runtime?.run ?? "").trim().split("\n");
    expect(check).toBe('test "$(node --version)" = "v$IMAGE_NODE"');
    expect(command).toBe(`NODE_TRANSPORT_NODES="$(command -v node)" bun tests/run-tests.ts ${RUNTIME_FILES.join(" ")}`);
  });

  test("the suite, which runs the same files on the node on PATH, runs on Node 24 before the image's Node is set up", () => {
    const suite = STEPS.findIndex((step) => step.run === "bun run test:coverage");
    const setups = STEPS.flatMap((step, index) => (step.uses?.startsWith("actions/setup-node@") ? [index] : []));
    expect(setups.filter((index) => index < suite).map((index) => STEPS[index].with?.["node-version"])).toEqual(["24"]);
    expect(setups.filter((index) => index > suite).map((index) => STEPS[index].with?.["node-version"])).toEqual([
      "${{ steps.image-node.outputs.version }}",
    ]);
  });
});
