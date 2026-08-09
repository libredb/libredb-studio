/**
 * Unit tests for the release SBOM (security programme control 2.2).
 *
 * Why a test for YAML: dropping the SBOM does not break a release. Every other
 * asset still uploads, publish-release still flips the draft, and the missing
 * document is discovered by whoever asked for it in a procurement thread months
 * later - by which time immutable releases mean it can never be added to that
 * release at all. That asymmetry is the same one release-provenance.test.ts
 * exists for.
 *
 * The licence assertion is not cosmetic either: with no node_modules present
 * Trivy emits the same component list with zero licence fields and logs a notice
 * nobody reads, so the SBOM would look complete and answer none of the questions
 * a diligence reviewer asks it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  run?: string;
  if?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
}
interface Job {
  name?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

const workflow = parseYaml(
  fs.readFileSync(path.join(__dirname, "../../.github/workflows/release-artifacts.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const sbom = workflow.jobs.sbom;
const sbomSteps = sbom?.steps ?? [];
const generate = sbomSteps.find((s) => s.run?.includes("cyclonedx"));
const upload = sbomSteps.find((s) => s.run?.includes("gh release upload"));
const dockerHubCheck = sbomSteps.find((s) => s.id === "dockerhub");
const dockerHubLogin = sbomSteps.find((s) => s.name === "Log in to Docker Hub");
const rename = sbomSteps.find((s) => s.name === "Name and version the SBOM's root component");
const publishRelease = workflow.jobs["publish-release"];
const verify = (publishRelease?.steps ?? []).find((s) => s.run?.includes("missing required asset"));

describe("the release SBOM job", () => {
  test("exists", () => {
    expect(sbom).toBeDefined();
  });

  test("waits for the draft, because assets can only be attached to a draft", () => {
    // Immutable releases (#154): a published release's asset set is frozen.
    expect(sbom.needs).toContain("draft");
    expect(sbom.needs).toContain("guard");
  });

  test("installs dependencies, or the SBOM carries no licences", () => {
    expect(sbomSteps.some((s) => s.uses === "./.github/actions/bun-install")).toBe(true);
  });

  test("never uses a bare bun install", () => {
    for (const step of sbomSteps) {
      expect({ name: step.name, bare: /(^|\s)bun install(\s|$)/.test(step.run ?? "") }).toEqual({
        name: step.name,
        bare: false,
      });
    }
  });

  test("emits CycloneDX and collects licences", () => {
    expect(generate?.run).toContain("--format cyclonedx");
    expect(generate?.run).toContain("--scanners license");
  });

  test("pins the generator by digest", () => {
    expect(generate?.run).toMatch(/aquasec\/trivy@sha256:[0-9a-f]{64}/);
  });

  test("names the asset after the released version", () => {
    expect(generate?.run).toContain("libredb-studio-${VERSION}.cdx.json");
    expect(upload?.run).toContain("gh release upload");
  });

  test("does not touch SHA256SUMS", () => {
    // scripts/render-homebrew-formula.mjs, the winget and Chocolatey packaging
    // and the npx launcher all parse that file. It describes downloadable
    // binaries; adding a document none of them fetch changes a contract three
    // channels depend on for nothing.
    for (const step of sbomSteps) {
      expect({ name: step.name, touches: (step.run ?? "").includes("SHA256SUMS") }).toEqual({
        name: step.name,
        touches: false,
      });
    }
  });
});

describe("the sbom job authenticates to Docker Hub when possible, and retries the pull", () => {
  // publish-release needs this job, so it now sits on the release chain -
  // the same fragile path where a failed release retries with a NEW patch
  // version, never the same tag. An anonymous, unretried Docker Hub pull here
  // could stall a release before publish.

  test("checks whether Docker Hub credentials are configured before deciding whether to log in", () => {
    expect(dockerHubCheck).toBeDefined();
    expect(dockerHubCheck?.run).toContain("DOCKER_HUB_TOKEN");
  });

  test("logs in to Docker Hub only when the check says credentials are available", () => {
    expect(dockerHubLogin).toBeDefined();
    expect(dockerHubLogin?.if).toBe("steps.dockerhub.outputs.enabled == 'true'");
    expect(dockerHubLogin?.with?.username).toBe("${{ vars.DOCKER_HUB_USERNAME }}");
  });

  test("retries the trivy pull/run rather than failing on the first blip", () => {
    expect(generate?.run).toContain("until docker run");
    expect(generate?.run).toMatch(/attempt/);
  });

  test("runs trivy as the invoking user, not root, since the next step patches this file in place", () => {
    // aquasec/trivy runs as root by default, so a bind-mounted output file
    // lands on the host owned by root, mode 644. Reproduced 2026-08-09
    // against the real pinned image: the "Name and version the SBOM's root
    // component" step's `fs.writeFileSync` on that same, already-existing
    // file needs write permission on the file itself, which the runner's own
    // non-root user does not have on a root-owned one - EACCES. Verified the
    // fix the same way: with --user "$(id -u):$(id -g)" the output is owned
    // by the invoking user and the patch step succeeds.
    //
    // Asserted as the flag immediately following `docker run --rm`, not a
    // bare substring match: this step's own comment above the command
    // explains the flag in prose and so also contains the literal text
    // `--user "$(id -u):$(id -g)"` - a substring check alone would still
    // pass with the flag removed from the actual command.
    const run = generate?.run ?? "";
    expect(run).toMatch(/docker run --rm \\\s*\n\s*--user "\$\(id -u\):\$\(id -g\)" \\/);
  });
});

describe("the sbom job names its root component, so it does not import as a project called '.'", () => {
  test("patches metadata.component.name after generating, before verifying or attesting", () => {
    expect(rename).toBeDefined();
    expect(rename?.run).toContain("metadata.component");
    expect(rename?.run).toContain("libredb-studio");
  });

  test("also sets metadata.component.version, so successive releases do not collapse into one project", () => {
    // Dependency-Track and similar CycloneDX consumers key a project by
    // name+version. Setting the name alone leaves version empty, and every
    // release's SBOM would then import as the same unversioned project,
    // each overwriting the last rather than recording its own release.
    expect(rename?.run).toContain("metadata.component.version");
    expect(rename?.run).toContain("$VERSION");
  });

  test("runs after generation and before verification and attestation", () => {
    const names = sbomSteps.map((s) => s.name);
    const renameIndex = names.indexOf(rename?.name ?? "");
    expect(renameIndex).toBeGreaterThan(names.indexOf(generate?.name ?? ""));
    expect(renameIndex).toBeLessThan(names.indexOf("Verify the SBOM describes something"));
    expect(renameIndex).toBeLessThan(names.indexOf("Attest the SBOM"));
  });
});

describe("publish-release refuses to publish without the SBOM", () => {
  test("waits for the sbom job", () => {
    expect(publishRelease?.needs).toContain("sbom");
  });

  test("requires the SBOM asset by name", () => {
    // The verification list is what makes a missing asset a failed run instead
    // of a published release that is quietly incomplete forever.
    expect(verify?.run).toContain('"libredb-studio-${TAG}.cdx.json"');
  });
});
