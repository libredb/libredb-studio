/**
 * Drift guard: SECURITY.md's bundled-runtime entry matches the fetch scripts (#545).
 *
 * The pinned Node.js runtime is fetched by a shell script rather than resolved
 * from `bun.lock`, so the CycloneDX SBOM never mentions it even though it is
 * the largest single binary in most packaged artefacts. SECURITY.md now
 * describes it by hand, and a hand-maintained component entry is exactly the
 * kind of thing that goes stale the first time someone bumps the pin.
 *
 * These tests read the version out of both scripts and require the document to
 * agree. A version bump that forgets the doc fails here rather than shipping a
 * security document that names the wrong runtime.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const LINUX_SCRIPT = "packaging/linux/fetch-node.sh";
const WINDOWS_SCRIPT = "packaging/windows/fetch-node.sh";
const SECURITY = read("SECURITY.md");

/** The `NODE_VERSION="..."` assignment in a fetch script. */
const pinnedVersion = (script: string): string => {
  const match = /^NODE_VERSION="([^"]+)"/m.exec(read(script));
  expect(match, `${script} has no NODE_VERSION assignment`).not.toBeNull();
  return (match as RegExpExecArray)[1];
};

describe("bundled Node.js runtime documentation", () => {
  test("both fetch scripts pin the same version", () => {
    // The scripts already tell each other to move together; this is the check
    // that says so out loud, and it is the precondition for everything below.
    expect(pinnedVersion(LINUX_SCRIPT)).toBe(pinnedVersion(WINDOWS_SCRIPT));
  });

  test("SECURITY.md names the pinned version", () => {
    const version = pinnedVersion(LINUX_SCRIPT);
    const section = SECURITY.slice(SECURITY.indexOf("#### Bundled Node.js runtime"));
    expect(section.length, "SECURITY.md has no bundled-runtime section").toBeGreaterThan(0);
    expect(section).toContain(version);
  });

  test("SECURITY.md names the upstream dist directory for that version", () => {
    // Provenance is half the point of the entry: a version with no origin does
    // not tell a reader where the bytes came from.
    const version = pinnedVersion(LINUX_SCRIPT);
    expect(SECURITY).toContain(`https://nodejs.org/dist/v${version}/`);
  });

  test("SECURITY.md names the exact artefacts each platform fetches", () => {
    const version = pinnedVersion(LINUX_SCRIPT);
    for (const artefact of [
      `node-v${version}-linux-x64.tar.xz`,
      `node-v${version}-linux-arm64.tar.xz`,
      `node-v${version}-win-x64.zip`,
    ]) {
      expect(SECURITY, `SECURITY.md does not name ${artefact}`).toContain(artefact);
    }
  });

  test("SECURITY.md cites both scripts as the source of truth", () => {
    expect(SECURITY).toContain(LINUX_SCRIPT);
    expect(SECURITY).toContain(WINDOWS_SCRIPT);
  });

  test("SECURITY.md still says the SBOM does not cover the runtime", () => {
    // The entry documents the gap; it does not close it. If someone later makes
    // the SBOM cover the runtime, this failing is the prompt to rewrite the
    // section rather than leave two contradictory claims in one document.
    expect(SECURITY).toContain("does **not** describe the pinned Node.js runtime");
  });

  test("the pin stays at or above the engines.node floor", () => {
    // The scripts say to keep the pin >= package.json's floor. Nothing checked.
    const engines = JSON.parse(read("package.json")).engines.node as string;
    const floor = /(\d+)/.exec(engines);
    expect(floor).not.toBeNull();
    const major = Number(pinnedVersion(LINUX_SCRIPT).split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(Number((floor as RegExpExecArray)[1]));
  });
});
