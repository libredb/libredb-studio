/**
 * Unit tests for the signed-provenance invariants of the publish workflows
 * (issue #123: npm provenance + SLSA build provenance).
 *
 * Why a test for YAML: dropping `--provenance` does NOT break a release. The
 * publish still succeeds, the tarball just ships unsigned - the guarantee
 * disappears silently and nobody notices until someone tries to verify a
 * months-old version. Dropping `id-token: write` fails the other way, loudly,
 * but only on the release commit, where the retry costs a whole patch version
 * (a published tag can never be re-published). Both directions are cheap to
 * pin here and expensive to discover in a live release.
 *
 * The same asymmetry drives the attestation assertions below: an artifact that
 * is uploaded before it is attested, or a job that lost `attestations: write`,
 * produces a release whose assets look fine and cannot be verified.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { PROVENANCE_SIGNER_WORKFLOW } from "../../bin/lib/launcher-utils.mjs";

interface Step {
  name?: string;
  run?: string;
  if?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
}

const workflow = (name: string): { jobs: Record<string, Job> } =>
  parseYaml(fs.readFileSync(path.join(__dirname, "../../.github/workflows", name), "utf8")) as {
    jobs: Record<string, Job>;
  };

const ATTEST_ACTION = "actions/attest-build-provenance@";
const isAttestStep = (s: Step): boolean => s.uses?.startsWith(ATTEST_ACTION) === true;
const subjectPathOf = (s: Step | undefined): string => String(s?.with?.["subject-path"] ?? "");

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

const releaseArtifacts = workflow("release-artifacts.yml");

/**
 * Every job that ships a release asset must attest it. `globs` are the subject
 * patterns the attestation has to cover - a job that grows a new artifact kind
 * (as desktop-appimage did with the GUI .deb) has to extend both the glob and
 * this list, which is the point.
 */
const ATTESTED_JOBS: { job: string; globs: string[] }[] = [
  { job: "publish", globs: ["libredb-studio-standalone-*.tar.gz", "libredb-studio-standalone-*.zip"] },
  { job: "linux-packages", globs: ["pkgs/*.deb", "pkgs/*.rpm"] },
  { job: "desktop-appimage", globs: ["dist-desktop/*.AppImage", "dist-desktop/*.deb"] },
  { job: "snap", globs: ["${{ steps.snapcraft.outputs.snap }}"] },
  // An unsigned SBOM is a text file anyone can rewrite, and it is the one asset
  // whose entire value is that its claims are trustworthy.
  { job: "sbom", globs: ["sbom/libredb-studio-*.cdx.json"] },
];

describe.each(ATTESTED_JOBS)("release-artifacts.yml attestation: $job", ({ job, globs }) => {
  const steps = releaseArtifacts.jobs[job]?.steps ?? [];
  const permissions = releaseArtifacts.jobs[job]?.permissions;
  const attestSteps = steps.filter(isAttestStep);
  const subjects = attestSteps.map(subjectPathOf).join("\n");

  test("keeps contents: write and adds the two permissions the attestation API needs", () => {
    expect(permissions?.contents).toBe("write");
    expect(permissions?.["id-token"]).toBe("write");
    expect(permissions?.attestations).toBe("write");
  });

  test("attests its artifacts", () => {
    expect(attestSteps.length).toBeGreaterThan(0);
    for (const glob of globs) {
      expect(subjects).toContain(glob);
    }
  });

  test("does not waste a subject slot on a checksum sidecar", () => {
    // Attesting a .sha256 text file proves nothing about the artifact it
    // describes - the artifact itself is the subject.
    expect(subjects).not.toContain(".sha256");
  });

  test("signs before it ships", () => {
    // Ordering is the difference between a failed run that published nothing
    // and a draft release carrying assets no attestation covers.
    const firstAttest = steps.findIndex(isAttestStep);
    const firstUpload = steps.findIndex((s) => s.run?.includes("gh release upload") === true);
    expect(firstUpload).toBeGreaterThan(-1);
    expect(firstAttest).toBeLessThan(firstUpload);
  });
});

const docker = workflow("docker-build-push.yml");
const dockerJob = docker.jobs["build-and-push"];
const dockerSteps = dockerJob?.steps ?? [];
const buildPush = dockerSteps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
const dockerAttest = dockerSteps.find(isAttestStep);

describe("docker-build-push.yml attestation", () => {
  test("the job can mint attestations without losing its registry write", () => {
    expect(dockerJob?.permissions?.["id-token"]).toBe("write");
    expect(dockerJob?.permissions?.attestations).toBe("write");
    expect(dockerJob?.permissions?.packages).toBe("write");
    expect(dockerJob?.permissions?.contents).toBe("read");
  });

  test("the attestation binds the digest buildx actually pushed", () => {
    // An image is attested by digest, never by tag: latest/main/dev move, and
    // the multi-arch manifest list digest is the only stable identity.
    expect(buildPush?.id).toBeTruthy();
    expect(dockerAttest?.with?.["subject-digest"]).toContain(`steps.${buildPush?.id}.outputs.digest`);
  });

  test("the subject is the untagged canonical GHCR name", () => {
    // Reuses the job's existing lowercase-image step: OCI names must be
    // lowercase, and the tag list is the wrong subject (it moves, and it may
    // carry the Docker Hub mirror too - GHCR is the canonical registry).
    const name = String(dockerAttest?.with?.["subject-name"] ?? "");
    expect(name).toContain("env.REGISTRY");
    expect(name).toContain("steps.image.outputs.name");
    expect(name).not.toContain("steps.meta.outputs.tags");
  });

  test("only release-context builds are attested", () => {
    // Branch pushes publish the mutable main/dev tags; signing those would fill
    // the transparency log with images no user installs.
    expect(dockerAttest?.if).toContain("github.event_name");
  });
});

describe("the launcher's pinned signer workflow", () => {
  // bin/studio.js pins --signer-workflow, so a renamed or moved workflow file
  // would make every npx user's verification fail the signer policy - and that
  // classifies as a definite negative, i.e. a refusal to start. This test turns
  // that runtime break into a CI break at rename time.
  const [, , ...workflowPath] = PROVENANCE_SIGNER_WORKFLOW.split("/");
  const fileName = workflowPath[workflowPath.length - 1];

  test("names a workflow file that exists at the pinned path", () => {
    expect(workflowPath.join("/")).toBe(`.github/workflows/${fileName}`);
    expect(fs.existsSync(path.join(__dirname, "../..", ...workflowPath))).toBe(true);
  });

  test("names the workflow that actually attests the standalone archives", () => {
    expect(fileName).toBe("release-artifacts.yml");
    const subjects = (releaseArtifacts.jobs.publish?.steps ?? []).filter(isAttestStep).map(subjectPathOf).join("\n");
    expect(subjects).toContain("libredb-studio-standalone-*.tar.gz");
  });

  test("is scoped to this repository", () => {
    expect(PROVENANCE_SIGNER_WORKFLOW.startsWith("libredb/libredb-studio/")).toBe(true);
  });
});

describe("attestation action pinning", () => {
  const attestUses = [releaseArtifacts, docker].flatMap((wf) =>
    Object.values(wf.jobs).flatMap((j) => (j.steps ?? []).filter(isAttestStep).map((s) => s.uses ?? "")),
  );

  test("every attest step is pinned to a full commit SHA", () => {
    expect(attestUses.length).toBeGreaterThan(0);
    for (const uses of attestUses) {
      expect(uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
    }
  });
});
