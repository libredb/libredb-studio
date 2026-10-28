/**
 * Facts in the Rancher documents that went stale once already, or that a reader acts on.
 *
 * `deploy/rancher/CATALOG_LISTING.md` called rancher/partner-charts#1168 open for weeks
 * after it merged on 2026-09-23, so the state of that pull request is pinned here.
 * `docs/RANCHER.md` declares the Rancher lines we support, which follow SUSE's lifecycle:
 * 2.9 to 2.11 are end of life, and the community builds of 2.12 to 2.14 stop at one patch
 * each, the later patches being Prime builds.
 * Its "Embedding in Rancher" section is a map into the other documents, so every link in
 * it must land on a file and a heading that exist, and it must not claim a listing for the
 * LibreDB Rancher extension, which is neither released nor listed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

/** GitHub's heading anchor: lower case, punctuation other than hyphens dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) out.add(slug(match[1]));
  }
  return out;
}

/** The text of one `## ` section, up to the next heading of the same level. */
function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`no section "## ${title}"`);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("slug", () => {
  test("follows GitHub's anchor rule", () => {
    expect(slug("Rancher mode values")).toBe("rancher-mode-values");
    expect(slug("12. Rancher mode")).toBe("12-rancher-mode");
    expect(slug("Platform discovery (Kubernetes)")).toBe("platform-discovery-kubernetes");
    expect(slug("Trusting a private CA")).toBe("trusting-a-private-ca");
  });
});

describe("section", () => {
  test("refuses a section that does not exist", () => {
    expect(() => section("# a\n## b\n", "c")).toThrow('no section "## c"');
  });

  test("runs to the end of the file when no heading follows", () => {
    expect(section("# a\n## b\ntext\n", "b")).toBe("## b\ntext\n");
  });
});

describe("deploy/rancher/CATALOG_LISTING.md", () => {
  const listing = read("deploy/rancher/CATALOG_LISTING.md");

  test("never calls rancher/partner-charts#1168 open, which merged on 2026-09-23", () => {
    expect(listing).not.toMatch(/#1168 is OPEN/i);
    expect(listing).not.toMatch(/submitted on 2026-09-09 is still open/);
    expect(listing).toMatch(/#1168[^\n]*merged on 2026-09-23/);
  });

  test("makes no claim about the Rancher extension, which is not listed", () => {
    expect(listing).not.toMatch(/partner-extensions/);
    expect(listing).not.toMatch(/UI extension/i);
  });
});

describe("docs/RANCHER.md", () => {
  const doc = read("docs/RANCHER.md");

  test("supports the Rancher lines SUSE has not ended, 2.12 and later", () => {
    const supported = section(doc, "Supported versions");
    expect(supported).toMatch(/\| SUSE Rancher Prime and Rancher \(community\) \| 2\.12 or later \|/);
    expect(supported).not.toMatch(/2\.9 or later/);
  });

  test("names where the community builds of 2.12 to 2.14 stop", () => {
    const supported = section(doc, "Supported versions");
    for (const version of ["v2.12.3", "v2.13.3", "v2.14.3"]) expect(supported).toContain(version);
    expect(supported).toMatch(/Prime/);
  });

  const embedding = section(doc, "Embedding in Rancher");

  test("every link of the Embedding in Rancher section lands on a file and heading that exist", () => {
    const links = [...embedding.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    const local = links.filter((href) => !/^https?:/.test(href));
    expect(local.length).toBeGreaterThan(4);
    for (const href of local) {
      const [path, anchor] = href.split("#");
      const target = path === "" ? "docs/RANCHER.md" : join(dirname("docs/RANCHER.md"), path);
      expect(existsSync(join(REPO_ROOT, target)), `${href}: ${target} exists`).toBe(true);
      if (anchor) expect(anchors(read(target)).has(anchor), `${href}: #${anchor} in ${target}`).toBe(true);
    }
  });

  test("claims no listing or release for the Rancher extension", () => {
    expect(embedding).toContain("libredb/libredb-studio-rancher-extension");
    expect(embedding).toMatch(/not released or listed yet/);
    expect(embedding).not.toMatch(/partner-extensions/);
    expect(embedding).not.toMatch(/Extensions page/);
  });

  test("says which Studio release Rancher mode needs", () => {
    expect(embedding).toMatch(/first Studio release after 1\.1\.0/);
  });
});
