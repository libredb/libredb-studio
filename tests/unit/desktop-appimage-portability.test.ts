/**
 * Unit tests for the glibc floor of the desktop AppImage.
 *
 * Why a test for a runner label: an AppImage inherits the glibc of the machine
 * that built it, and that dependency only ever points one way. Building on
 * `ubuntu-latest` silently raises the floor every time GitHub moves the label
 * to a newer image - the artifact still builds, still uploads, still runs on
 * the runner and on any recent desktop, and simply stops starting on older
 * targets with `version 'GLIBC_2.xx' not found`. No release gate can see it,
 * because the machine that would notice is not in the pipeline.
 *
 * Measured on 0.13.1 (built on ubuntu-latest, then 24.04): every bundled GTK
 * and WebKit library required GLIBC_2.38 and the Tauri binary referenced
 * GLIBC_2.39, so the AppImage could not load a single shared object on Ubuntu
 * 22.04 (glibc 2.35) - the oldest still-supported LTS, which is also what
 * AppImageHub's review CI runs.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface MatrixEntry {
  arch: string;
  runner: string;
}
interface Job {
  strategy?: { matrix?: { include?: MatrixEntry[] } };
  steps?: { name?: string; run?: string }[];
}

const workflow = (name: string): { jobs: Record<string, Job> } =>
  parseYaml(fs.readFileSync(path.join(__dirname, "../../.github/workflows", name), "utf8")) as {
    jobs: Record<string, Job>;
  };

const desktopJob = workflow("release-artifacts.yml").jobs["desktop-appimage"];
const smokeJob = workflow("flatpak-smoke.yml").jobs.appimage;
const desktopMatrix = desktopJob?.strategy?.matrix?.include ?? [];
const smokeMatrix = smokeJob?.strategy?.matrix?.include ?? [];
const x64Runner = (matrix: MatrixEntry[]): string | undefined => matrix.find((entry) => entry.arch === "x64")?.runner;
const aptStep = (job: Job | undefined): string =>
  job?.steps?.find((step) => step.run?.includes("apt-get install"))?.run ?? "";

describe("release-artifacts.yml desktop-appimage glibc floor", () => {
  test("builds every architecture on a pinned runner image, never a floating label", () => {
    expect(desktopMatrix.length).toBeGreaterThan(0);
    for (const entry of desktopMatrix) {
      expect(entry.runner).not.toContain("latest");
    }
  });

  test("builds the x64 AppImage on the oldest still-supported LTS", () => {
    // AppImageHub's review CI (code/worker.sh) runs the submitted AppImage on
    // ubuntu-22.04 and fails the submission when no window appears, so this
    // label is what keeps the catalog listing alive as well as the users on
    // enterprise distributions the AppImage exists for.
    expect(x64Runner(desktopMatrix)).toBe("ubuntu-22.04");
  });

  test("the pull-request AppImage smoke builds on the same image the release does", () => {
    // flatpak-smoke.yml is the only job that builds an AppImage outside a
    // release, so it is the only place a build break on the pinned image can
    // surface before a tag exists. Letting the two drift means the release
    // builds a configuration nothing ever exercised, on a job that is a hard
    // release gate.
    expect(smokeMatrix.length).toBeGreaterThan(0);
    expect(x64Runner(smokeMatrix)).toBe(x64Runner(desktopMatrix));
  });

  test("both AppImage builds install the tool the permission repack needs", () => {
    // Without squashfs-tools the repack in scripts/build-desktop-appimage.sh
    // cannot run, and the job fails on the release commit rather than on a PR.
    // Neither runner image preinstalls it.
    for (const run of [aptStep(desktopJob), aptStep(smokeJob)]) {
      expect(run).toContain("squashfs-tools");
    }
  });
});
