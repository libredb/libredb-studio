import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");

// These limits use recent successful runs as a baseline, with extra room for
// runner variation and the external registries or services each job touches.
// Keeping the full matrix here also makes a newly added job fail until its
// expected runtime has been considered.
const EXPECTED_TIMEOUTS: Record<string, Record<string, number>> = {
  "azure-marketplace-package.yml": { package: 10 },
  "codeql.yml": { analyze: 15 },
  "do-packer-build.yml": { build: 30 },
  "flatpak-smoke.yml": { appimage: 30, flatpak: 20 },
  "integration-check.yml": { "integration-rules": 10 },
  "npm-publish.yml": { validate: 25, publish: 15, "dispatch-smoke": 5 },
  "npx-engine-smoke.yml": { "npx-smoke": 30 },
  "operator-release.yml": { "build-and-push": 30, "submit-catalogs": 30 },
  "release-artifacts.yml": {
    guard: 5,
    channels: 10,
    draft: 5,
    build: 20,
    "windows-package": 30,
    publish: 15,
    sbom: 15,
    "linux-packages": 20,
    "desktop-appimage": 30,
    snap: 30,
    "publish-release": 10,
    "dispatch-downstream": 5,
    chocolatey: 15,
    winget: 15,
  },
  "update-sponsors.yml": { "update-sponsors": 5 },
};

interface WorkflowJob {
  "timeout-minutes"?: unknown;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function readTimeouts(file: string): Record<string, unknown> {
  const workflow = parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
  return Object.fromEntries(
    Object.entries(workflow.jobs ?? {}).map(([job, definition]) => [job, definition["timeout-minutes"]]),
  );
}

describe("workflow job timeouts", () => {
  test.each(Object.entries(EXPECTED_TIMEOUTS))("%s has a deliberate timeout for every job", (file, expected) => {
    expect(readTimeouts(file)).toStrictEqual(expected);
  });

  test("uses limits sized for different kinds of work", () => {
    const values = Object.values(EXPECTED_TIMEOUTS).flatMap(Object.values);
    expect(new Set(values).size).toBeGreaterThan(1);
  });
});
