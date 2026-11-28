/**
 * When the workflows run, and what a pull request pays for.
 *
 * Every rule here fails silently when it breaks: a branch push that builds an image
 * nobody pulls is still green, and so is a pull request run that a newer push should
 * have cancelled. So the triggers are read back out of the workflow files and held
 * here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const WORKFLOWS = path.join(import.meta.dir, "../../.github/workflows");

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: string | boolean };
  readonly jobs: Readonly<Record<string, Job>>;
}

function workflow(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
}

function text(file: string): string {
  return readFileSync(path.join(WORKFLOWS, file), "utf8");
}

describe("image builds", () => {
  const docker = workflow("docker-build-push.yml");

  test("docker-build-push.yml builds on push to main, a release or a dispatch, never on a branch push", () => {
    // feat/** and fix/** pushes used to build and publish a `dev` tag that only this
    // workflow's own Channel E2E pulled: a multi-architecture image build per pushed
    // commit that no user installs.
    expect(Object.keys(docker.on).sort()).toEqual(["push", "release", "workflow_dispatch"]);
    expect((docker.on.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  test("no image tag is published for a branch other than main", () => {
    const source = text("docker-build-push.yml");
    expect(source).not.toContain("type=raw,value=dev");
    expect(source).not.toContain("github.ref != 'refs/heads/main'");
  });

  test("every image build is a two-architecture manifest", () => {
    const build = docker.jobs["build-and-push"]?.steps?.find((step) => step.id === "build");
    expect(build?.with?.platforms).toBe("${{ env.PLATFORMS }}");
    expect(docker.env?.PLATFORMS).toBe("linux/amd64,linux/arm64");
    // With every build two-architecture, the emulator is needed on every build too.
    const qemu = docker.jobs["build-and-push"]?.steps?.find((step) =>
      step.uses?.startsWith("docker/setup-qemu-action@"),
    );
    expect(qemu).toBeDefined();
    expect(qemu?.if).toBeUndefined();
  });
});
