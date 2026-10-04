/**
 * Unit tests for the AUR publish job in release-artifacts.yml (issue #971).
 *
 * Why a test for YAML: this job holds an SSH key that can rewrite a package
 * every Arch user of LibreDB Studio installs, and the failure modes that matter
 * are all in its wiring, not in any code a unit test would otherwise reach. It
 * must stay off until the channel is live (the package is staged before the
 * account exists), it must never push a prerelease (pkgver cannot hold one),
 * the key must not enter the build container, and the host key must be pinned
 * rather than learned on first connect.
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
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
  "continue-on-error"?: boolean;
}

const workflow = parseYaml(
  fs.readFileSync(path.join(__dirname, "../../.github/workflows/release-artifacts.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const aur = workflow.jobs.aur;
const steps = aur?.steps ?? [];
const gate = steps.find((s) => s.id === "aur");
const render = steps.find((s) => s.run?.includes("render-aur-pkgbuild.mjs"));
const build = steps.find((s) => s.run?.includes("makepkg"));
const push = steps.find((s) => s.run?.includes("git push"));
const gated = steps.filter((s) => s !== gate);

describe("the AUR publish job", () => {
  test("runs after the release is published and reads the channel switchboard", () => {
    expect(aur).toBeDefined();
    // The PKGBUILD downloads the tarballs from the release URL, which is public
    // only once the release is.
    expect(aur?.needs).toEqual(expect.arrayContaining(["guard", "publish-release", "channels"]));
    expect(workflow.jobs.channels.outputs?.aur).toBe("${{ steps.flags.outputs.aur }}");
  });

  test("never runs for a prerelease tag", () => {
    expect(aur?.if).toContain("!contains(needs.guard.outputs.version, '-')");
  });

  test("is gated on both the inventory flag and the SSH key", () => {
    expect(gate?.env?.CI_ENABLED).toBe("${{ needs.channels.outputs.aur }}");
    expect(gate?.env?.AUR_SSH_PRIVATE_KEY).toBe("${{ secrets.AUR_SSH_PRIVATE_KEY }}");
    expect(gated.length).toBeGreaterThan(0);
    for (const step of gated) {
      expect(step.if).toBe("steps.aur.outputs.enabled == 'true'");
    }
  });

  test("renders the PKGBUILD from the tagged packaging/linux files and SHA256SUMS", () => {
    expect(render?.run).toContain("packaging/aur/PKGBUILD");
    expect(render?.run).toContain("dist/SHA256SUMS");
    expect(render?.run).toContain("packaging/linux");
  });

  test("builds and lints in an Arch container pinned by digest, without the key", () => {
    expect(build?.run).toMatch(/archlinux(?::[\w.-]+)?@sha256:[0-9a-f]{64}/);
    expect(build?.run).toContain("--printsrcinfo");
    expect(build?.run).toContain("namcap");
    expect(build?.env?.AUR_SSH_PRIVATE_KEY).toBeUndefined();
    expect(build?.run).not.toContain("AUR_SSH_PRIVATE_KEY");
    // A broken package is our bug: it must fail the job.
    expect(build?.["continue-on-error"]).toBeUndefined();
    expect(aur?.["continue-on-error"]).toBeUndefined();
  });

  test("pins the AUR host key instead of trusting the first connection", () => {
    expect(push?.run).toContain("StrictHostKeyChecking=yes");
    expect(push?.run).toContain("aur.archlinux.org ssh-ed25519 ");
    expect(push?.run).not.toContain("ssh-keyscan");
  });

  test("pushes the whole AUR file set to master, as the project account", () => {
    for (const file of ["PKGBUILD", ".SRCINFO", "libredb-studio-bin.install", "LICENSE", "REUSE.toml"]) {
      expect(push?.run).toContain(file);
    }
    expect(push?.run).toContain("HEAD:master");
    expect(push?.run).toContain("channels@libredb.org");
  });

  test("ships every file of the AUR file set in packaging/aur", () => {
    for (const file of ["PKGBUILD", ".SRCINFO", "libredb-studio-bin.install", "LICENSE", "REUSE.toml"]) {
      expect(fs.existsSync(path.join(__dirname, "../../packaging/aur", file))).toBe(true);
    }
  });
});
