/**
 * Unit tests for the signed-provenance invariants of the publish workflows
 * (issue #123, step 1: npm provenance).
 *
 * Why a test for YAML: dropping `--provenance` does NOT break a release. The
 * publish still succeeds, the tarball just ships unsigned - the guarantee
 * disappears silently and nobody notices until someone tries to verify a
 * months-old version. Dropping `id-token: write` fails the other way, loudly,
 * but only on the release commit, where the retry costs a whole patch version
 * (a published tag can never be re-published). Both directions are cheap to
 * pin here and expensive to discover in a live release.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
}

const workflow = (name: string): { jobs: Record<string, Job> } =>
  parseYaml(fs.readFileSync(path.join(__dirname, "../../.github/workflows", name), "utf8")) as {
    jobs: Record<string, Job>;
  };

const npmPublish = workflow("npm-publish.yml");
const publishJob = npmPublish.jobs.publish;
const publishSteps = publishJob.steps ?? [];
const realPublish = publishSteps.find((s) => s.run?.includes("npm publish") && !s.run.includes("--dry-run"));
const dryRunPublish = publishSteps.find((s) => s.run?.includes("--dry-run"));

describe("npm-publish.yml provenance", () => {
  test("the publish job requests the OIDC token npm needs to sign", () => {
    // libnpmpublish throws EUSAGE without ACTIONS_ID_TOKEN_REQUEST_URL, which
    // GitHub only injects when the job asks for id-token: write.
    expect(publishJob.permissions?.["id-token"]).toBe("write");
  });

  test("the publish job keeps contents: read (job permissions replace the workflow block)", () => {
    expect(publishJob.permissions?.contents).toBe("read");
  });

  test("the real publish signs the tarball", () => {
    expect(realPublish).toBeDefined();
    expect(realPublish?.run).toContain("--provenance");
  });

  test("the real publish stays public (npm refuses provenance for private packages)", () => {
    expect(realPublish?.run).toContain("--access public");
  });

  test("the dry run does not ask for provenance - there is no tarball to attest", () => {
    expect(dryRunPublish).toBeDefined();
    expect(dryRunPublish?.run).not.toContain("--provenance");
  });
});
