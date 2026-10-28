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
 * `deploy/rancher/E2E_VALIDATION_TASK.md` carries the Rancher-mode scenarios R1 to R6,
 * each with what to expect.
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

/** Checks every relative link of `text`, read as part of `from`, and returns how many there were. */
function localLinksResolve(text: string, from: string): number {
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const local = links.filter((href) => !/^https?:/.test(href));
  for (const href of local) {
    const [path, anchor] = href.split("#");
    const target = path === "" ? from : join(dirname(from), path);
    expect(existsSync(join(REPO_ROOT, target)), `${href}: ${target} exists`).toBe(true);
    if (anchor) expect(anchors(read(target)).has(anchor), `${href}: #${anchor} in ${target}`).toBe(true);
  }
  return local.length;
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

  test("keeps the chart's Rancher range apart from Rancher mode, validated on 2.15 only", () => {
    const supported = section(doc, "Supported versions");
    expect(supported).toMatch(
      /That range is the chart's\. Rancher mode and the LibreDB Rancher extension are validated on Rancher 2\.15 only/,
    );
  });

  test("claims no Rancher-mode validation for 2.12.3 and 2.13.3, which were never measured", () => {
    const supported = section(doc, "Supported versions");
    expect(supported).not.toMatch(/support for their later patches rests on it/);
    expect(supported).toMatch(/v2\.14\.3 is validated/);
    expect(supported).toMatch(/2\.12 and 2\.13 install the chart, not validated in Rancher mode/);
  });

  const embedding = section(doc, "Embedding in Rancher");

  test("every link of the Embedding in Rancher section lands on a file and heading that exist", () => {
    expect(localLinksResolve(embedding, "docs/RANCHER.md")).toBeGreaterThan(4);
  });

  test("states that Rancher mode is validated on 2.15 only, and why 2.12 and 2.13 fail", () => {
    expect(embedding).toMatch(/It is validated on Rancher 2\.15 only, community v2\.15\.2\./);
    expect(embedding).toMatch(/On 2\.12 and 2\.13 Rancher refuses the `groups` scope its values request\./);
  });

  test("states only what is enforced about custom connections", () => {
    expect(embedding).not.toMatch(/Custom connections are off/);
    expect(embedding).toMatch(/Set `config\.allowCustomConnections: false`/);
    expect(embedding).toMatch(/Studio does not force it/);
    const setup = embedding.slice(embedding.indexOf("### Setting it up"), embedding.indexOf("### What we measured"));
    expect(setup).toContain("`config.allowCustomConnections: false`");
  });

  test("gives the Studio-side revocation bound as a design bound that R5 measures", () => {
    const measured = embedding.slice(
      embedding.indexOf("### What we measured"),
      embedding.indexOf("### Not tested yet"),
    );
    expect(measured).toMatch(/By design Studio then follows/);
    expect(measured).toMatch(/scenario R5 of the E2E task measures it/);
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

describe("deploy/rancher/E2E_VALIDATION_TASK.md", () => {
  const task = read("deploy/rancher/E2E_VALIDATION_TASK.md");

  test("carries the Rancher-mode scenarios R1 to R6, each with what to expect", () => {
    const ids = [...task.matchAll(/^### (R\d) - /gm)].map((m) => m[1]);
    expect(ids).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    for (const id of ids) {
      const start = task.indexOf(`### ${id} - `);
      const next = task.indexOf("\n### ", start + 1);
      expect(task.slice(start, next < 0 ? undefined : next)).toContain("Expect:");
    }
  });

  const rancherMode = task.slice(task.indexOf("## Phase 3b"), task.indexOf("## Phase 4"));

  test("every link of the Rancher-mode phase lands on a file and heading that exist", () => {
    expect(localLinksResolve(rancherMode, "deploy/rancher/E2E_VALIDATION_TASK.md")).toBe(3);
  });

  test("installs Studio with custom connections off, the precondition of R3", () => {
    expect(rancherMode).toContain("`config.allowCustomConnections: false`");
  });

  test("expects the password_login_disabled reason in the audit log, not in the 403 body", () => {
    const r4 = rancherMode.slice(rancherMode.indexOf("### R4"), rancherMode.indexOf("### R5"));
    expect(r4).not.toMatch(/403 with reason/);
    expect(r4).toMatch(/audit log records a `login_failure` with reason `password_login_disabled`/);
  });
});

describe("docs/OIDC.md", () => {
  const oidc = read("docs/OIDC.md");

  test("matches the 2.14.3 measurement: groups is granted when the client lists it", () => {
    expect(oidc).not.toMatch(/on 2\.14 use \[openid, profile\]/);
    expect(oidc).toMatch(/\| 2\.14 \| `openid profile groups`, with `groups` in the client's `spec\.scopes`/);
  });
});
