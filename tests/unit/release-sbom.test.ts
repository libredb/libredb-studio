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
