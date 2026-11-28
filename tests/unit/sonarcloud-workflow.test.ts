import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const workflow = parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as {
  jobs: { sonarcloud: { if: string } };
};
const canonical = "libredb/libredb-studio";
const fork = "contributor/libredb-studio";

describe("SonarCloud workflow", () => {
  test.each([
    // A pull request runs no SonarCloud analysis: the job runs on main's pushes and
    // on dispatches of the canonical repository, where SONAR_TOKEN is readable.
    ["canonical push", canonical, "push", "", "contributor", true],
    ["canonical workflow_dispatch", canonical, "workflow_dispatch", "", "contributor", true],
    ["canonical pull request", canonical, "pull_request", canonical, "contributor", false],
    ["fork push", fork, "push", "", "contributor", false],
    ["external pull request", canonical, "pull_request", fork, "contributor", false],
    ["fork-local pull request", fork, "pull_request", fork, "contributor", false],
    ["Dependabot pull request", canonical, "pull_request", canonical, "dependabot[bot]", false],
  ])("%s", (_name, repository, eventName, headRepository, actor, expected) => {
    // The guard uses string comparisons and boolean operators shared by Actions and JavaScript.
    const actual = runInNewContext(
      workflow.jobs.sonarcloud.if,
      {
        github: {
          repository,
          event_name: eventName,
          actor,
          head_ref: "dependabot/update-package",
          event: { pull_request: { head: { repo: { full_name: headRepository } } } },
        },
      },
      { timeout: 100 },
    );
    expect(actual).toBe(expected);
  });
});
