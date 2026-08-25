/**
 * Unit tests for the chart release's title and notes in helm-release.yml.
 *
 * Why a test for release copy: this text is the only explanation a visitor to
 * the Releases page ever gets for why the repository carries two version
 * streams - the application (`0.13.4`) and the chart
 * (`libredb-studio-0.1.49`). It used to be the chart's one-line `description:`
 * repeated verbatim on every chart release, which answers a question nobody
 * asked. The failure mode of the replacement is equally silent: a stale
 * version placeholder still renders (as literal `__CHART_VERSION__`), a
 * doc link whose anchor drifted still renders (as a link to the top of the
 * file), and an unquoted heredoc silently executes the `$(...)` and backticks
 * inside the markdown instead of printing them. None of these fails a run.
 *
 * Same asymmetry as tests/unit/security-scan-workflow.test.ts, applied to the
 * one workflow step whose output is read by humans rather than by tooling.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

const repoRoot = path.join(__dirname, "../..");
const workflowFile = path.join(repoRoot, ".github/workflows/helm-release.yml");
const workflow = parseYaml(fs.readFileSync(workflowFile, "utf8")) as Workflow;

const publishStep = (workflow.jobs["release-github-pages"]?.steps ?? []).find((s) =>
  s.name?.startsWith("Publish chart release"),
);
const script = publishStep?.run ?? "";

/**
 * The notes markdown, extracted from the quoted heredoc that writes it. Kept
 * as a separate extraction (rather than asserting against the whole script)
 * so a match can never be satisfied by a shell comment elsewhere in the step.
 */
function notesBody(): string {
  const match = /<<'NOTES'\n([\s\S]*?)\nNOTES\n/.exec(script);
  return match?.[1] ?? "";
}

/** GitHub's heading-anchor slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
}

describe("helm-release.yml chart release notes", () => {
  test("the publish step exists and is the one that creates the release", () => {
    expect(publishStep).toBeDefined();
    expect(script).toContain("gh release create");
  });

  test("notes are not the chart's description line repeated", () => {
    // The old body: `desc=$(grep '^description:' ... )` passed as --notes.
    expect(script).not.toContain("^description:");
  });

  test("the heredoc is quoted, so backticks and $(...) stay literal markdown", () => {
    // An unquoted heredoc would run the command substitutions in the install
    // snippets and swallow every backtick-quoted term in the prose.
    expect(script).toContain("<<'NOTES'");
    expect(notesBody().length).toBeGreaterThan(0);
  });

  test("both version numbers are substituted, not left as placeholders", () => {
    const body = notesBody();
    expect(body).toContain("__CHART_VERSION__");
    expect(body).toContain("__APP_VERSION__");
    // Every placeholder the body uses must have a substitution in the script.
    for (const placeholder of new Set(body.match(/__[A-Z_]+__/g) ?? [])) {
      expect(script).toContain(`s|${placeholder}|`);
    }
  });

  test("the title carries both versions instead of repeating the tag", () => {
    expect(script).toMatch(/--title "[^"]*\$\{?version\}?[^"]*"/);
    expect(script).toMatch(/--title "[^"]*\$\{?app_version\}?[^"]*"/);
  });

  test("the notes tell the reader how to install this exact chart version", () => {
    const body = notesBody();
    expect(body).toContain("helm repo add libredb https://libredb.org/libredb-studio/");
    expect(body).toContain("oci://ghcr.io/libredb/charts/libredb-studio");
    // Pinned installs only: an unpinned command on a versioned release page
    // would install something other than the release being read.
    for (const line of body.split("\n").filter((l) => l.includes("helm install"))) {
      expect(line).toContain("--version __CHART_VERSION__");
    }
  });

  test("the notes explain the two release streams and name appVersion", () => {
    const body = notesBody();
    expect(body).toContain("appVersion");
    expect(body).toContain("__APP_VERSION__");
  });

  test("the rationale link resolves to a real heading in docs/HELM_CHART.md", () => {
    const link = /docs\/HELM_CHART\.md#([a-z0-9-]+)/.exec(notesBody());
    expect(link).not.toBeNull();
    const doc = fs.readFileSync(path.join(repoRoot, "docs/HELM_CHART.md"), "utf8");
    const anchors = (doc.match(/^#{1,6} .+$/gm) ?? []).map((h) => slug(h.replace(/^#+ /, "")));
    // No link means the fallback "" - which no heading can produce, so the
    // assertion still fails rather than passing vacuously.
    expect(anchors).toContain(link?.[1] ?? "");
  });
});
