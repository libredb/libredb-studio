/**
 * Unit tests for the Artifact Hub repository metadata, artifacthub-repo.yml.
 *
 * Artifact Hub reads that file from two places: next to index.yaml on gh-pages
 * for the HTTP repository, and from the `artifacthub.io` tag of
 * oci://ghcr.io/libredb/charts/libredb-studio for the OCI one. The two
 * repositories have different Artifact Hub IDs, so the OCI copy is derived from
 * this file in helm-release.yml's release-oci job rather than kept by hand.
 *
 * The ignore entry exists because chart versions 0.1.1 and 0.1.9 to 0.1.11
 * shipped an artifacthub.io/changes annotation Artifact Hub cannot parse
 * (see checkChangesAnnotation in scripts/sync-chart-version.mjs). Released
 * charts are immutable (#167), so Artifact Hub reported them as tracking errors
 * on every scan. The regex must name those four and nothing else: an
 * unanchored or loose pattern would silently drop a current release from the
 * listing.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface RepoMetadata {
  repositoryID: string;
  owners: { name: string; email: string }[];
  ignore?: { name: string; version?: string }[];
}
interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

const ROOT = path.join(__dirname, "../..");
const HTTP_REPOSITORY_ID = "9bb770ba-de64-4168-8ab5-bfc6b4a884e9";
const OCI_REPOSITORY_ID = "47974612-63a3-40f0-9bf8-41593ec2117d";
const UNPARSEABLE_VERSIONS = ["0.1.1", "0.1.9", "0.1.10", "0.1.11"];

const metadataText = fs.readFileSync(path.join(ROOT, "artifacthub-repo.yml"), "utf8");
const metadata = parseYaml(metadataText) as RepoMetadata;
const workflow = parseYaml(fs.readFileSync(path.join(ROOT, ".github/workflows/helm-release.yml"), "utf8")) as Workflow;
const ociSteps = workflow.jobs["release-oci"].steps ?? [];

describe("artifacthub-repo.yml", () => {
  test("carries the HTTP repository's ID for the verified publisher badge", () => {
    expect(metadata.repositoryID).toBe(HTTP_REPOSITORY_ID);
  });

  test("ignores exactly the chart versions Artifact Hub cannot parse", () => {
    expect(metadata.ignore).toHaveLength(1);
    const [entry] = metadata.ignore ?? [];
    expect(entry.name).toBe("libredb-studio");
    // Artifact Hub matches with Go's regexp; this pattern uses nothing JS reads differently.
    const pattern = new RegExp(entry.version ?? "");
    for (const version of UNPARSEABLE_VERSIONS) {
      expect(pattern.test(version)).toBe(true);
    }
    for (const version of ["0.1.0", "0.1.12", "0.1.19", "0.1.100", "0.1.103", "0.1.110", "10.1.1", "0.1.1-rc.1"]) {
      expect(pattern.test(version)).toBe(false);
    }
  });
});

describe("helm-release.yml release-oci", () => {
  const names = ociSteps.map((step) => step.name);
  const setup = ociSteps.find((step) => step.uses?.startsWith("oras-project/setup-oras@"));
  const push = ociSteps.find((step) => step.name === "Push Artifact Hub metadata");

  test("installs a pinned oras by commit SHA", () => {
    expect(setup?.uses).toMatch(/^oras-project\/setup-oras@[0-9a-f]{40}$/);
    expect(setup?.with?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("pushes the metadata after the chart, so a failed chart push publishes no metadata", () => {
    expect(push).toBeDefined();
    expect(names.indexOf("Push Artifact Hub metadata")).toBeGreaterThan(names.indexOf("Push to OCI registry"));
  });

  test("derives the OCI copy from artifacthub-repo.yml with the OCI repository's ID", () => {
    const run = push?.run ?? "";
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain(`s/^repositoryID: .*/repositoryID: ${OCI_REPOSITORY_ID}/`);
    expect(run).toContain("artifacthub-repo.yml");
    expect(run).toContain("oras push ghcr.io/libredb/charts/libredb-studio:artifacthub.io");
    expect(run).toContain("--config /dev/null:application/vnd.cncf.artifacthub.config.v1+yaml");
    expect(run).toContain("artifacthub-repo.yml:application/vnd.cncf.artifacthub.repository-metadata.layer.v1.yaml");
  });

  test("the derived copy keeps the owners and the ignore list", () => {
    const derived = parseYaml(
      metadataText.replace(/^repositoryID: .*$/m, `repositoryID: ${OCI_REPOSITORY_ID}`),
    ) as RepoMetadata;
    expect(derived.repositoryID).toBe(OCI_REPOSITORY_ID);
    expect(derived.owners).toEqual(metadata.owners);
    expect(derived.ignore).toEqual(metadata.ignore);
  });
});
