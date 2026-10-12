/** The pure parts of tests/live/firestore-evidence.ts: its arguments, the Java floor, and the fixture budget. */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  FIXTURE_BUDGET_BYTES,
  fixtureBudget,
  insideDirectory,
  javaMajor,
  runArguments,
} from "../../../live/firestore-evidence";

const ROOT = path.resolve(import.meta.dir, "../../../..");

describe("runArguments", () => {
  test("takes the jar's absolute path outside the repository", () => {
    expect(runArguments(["--jar", "/opt/jars/cloud-firestore-emulator-v1.22.0.jar"])).toEqual({
      jar: "/opt/jars/cloud-firestore-emulator-v1.22.0.jar",
    });
  });

  test("refuses a missing, relative or in-repository jar with a sentence", () => {
    expect(() => runArguments([])).toThrow("--jar takes the absolute path of the cloud-firestore-emulator 1.22.0 jar");
    expect(() => runArguments(["--jar", "emulator.jar"])).toThrow("--jar takes the absolute path");
    expect(() => runArguments(["--jar", path.join(ROOT, "emulator.jar")])).toThrow(
      "--jar must be outside the repository: it is a 131 MB binary that is never committed",
    );
  });
});

describe("javaMajor", () => {
  test("reads the major version of both version spellings", () => {
    expect(javaMajor('openjdk version "25.0.4.1" 2026-08-18')).toBe(25);
    expect(javaMajor('openjdk version "21.0.9" 2025-10-21 LTS')).toBe(21);
    expect(javaMajor('java version "1.8.0_392"')).toBe(8);
  });

  test("refuses text that names no version", () => {
    expect(() => javaMajor("command not found")).toThrow("java -version printed no version");
  });
});

describe("fixtureBudget", () => {
  test("answers the total bytes of the files, counted as UTF-8", () => {
    expect(fixtureBudget({ "a.json": "ab", "b.json": "Ａ" })).toBe(5);
  });

  test("refuses a set at or over 1 MB, so nothing is written", () => {
    expect(FIXTURE_BUDGET_BYTES).toBe(1_000_000);
    expect(() => fixtureBudget({ "big.json": "x".repeat(FIXTURE_BUDGET_BYTES) })).toThrow(
      "the captures total 1000000 bytes, at or over the 1000000-byte budget of spec 9: nothing was written",
    );
  });
});

describe("insideDirectory", () => {
  test("is true for the root and below it, false beside it", () => {
    expect(insideDirectory("/repo", "/repo")).toBe(true);
    expect(insideDirectory("/repo", "/repo/tests")).toBe(true);
    expect(insideDirectory("/repo", "/repository")).toBe(false);
    expect(insideDirectory("/repo", "/")).toBe(false);
  });
});
