/** The version floor: AnalyzePlan's spark_version text read, then held to 4.1.0. */
import { describe, expect, test } from "bun:test";
import { meetsSparkFloor, parseSparkVersion } from "@/lib/db/providers/sql/spark/version";

describe("parseSparkVersion", () => {
  test("reads the leading major.minor.patch and ignores a vendor suffix", () => {
    expect(parseSparkVersion("4.2.0")).toEqual({ major: 4, minor: 2, patch: 0, preRelease: false });
    expect(parseSparkVersion("4.1.3-vendor.1")).toEqual({ major: 4, minor: 1, patch: 3, preRelease: false });
    expect(parseSparkVersion("3.5.9")).toEqual({ major: 3, minor: 5, patch: 9, preRelease: false });
    expect(parseSparkVersion("10.0.12")).toEqual({ major: 10, minor: 0, patch: 12, preRelease: false });
  });

  test("marks the three pre-release suffixes", () => {
    for (const text of ["4.1.0-preview3", "4.1.0-rc1", "4.1.0-SNAPSHOT", "4.1.1-SNAPSHOT", "4.1.0-rc2.extra"]) {
      expect(parseSparkVersion(text)?.preRelease).toBe(true);
    }
    for (const text of ["4.1.0-previewer", "4.1.0-rcX", "4.1.0-SNAPSHOTS", "4.1.0+build.7"]) {
      expect(parseSparkVersion(text)?.preRelease).toBe(false);
    }
  });

  test.each([
    "",
    "4.1",
    "v4.1.0",
    " 4.1.0",
    "four.one.zero",
    "4..1.0",
    "1234567890.1.0",
    "4.1234567890.0",
    "4.1.1234567890",
  ])("refuses %p as unreadable, never cut to its first nine digits", (text) => {
    expect(parseSparkVersion(text)).toBeUndefined();
  });
});

describe("meetsSparkFloor", () => {
  const meets = (text: string) =>
    meetsSparkFloor(parseSparkVersion(text) ?? { major: 0, minor: 0, patch: 0, preRelease: false });

  test("4.1.0 and later pass, a vendor suffix and a later pre-release included", () => {
    for (const text of ["4.1.0", "4.1.3", "4.1.3-vendor.1", "4.2.0", "4.1.1-SNAPSHOT", "4.2.0-preview1", "5.0.0"]) {
      expect({ text, meets: meets(text) }).toEqual({ text, meets: true });
    }
  });

  test("below 4.1.0 fails, and so does a pre-release of exactly 4.1.0", () => {
    for (const text of ["3.5.9", "4.0.4", "4.0.99", "3.99.99", "4.1.0-preview3", "4.1.0-rc1", "4.1.0-SNAPSHOT"]) {
      expect({ text, meets: meets(text) }).toEqual({ text, meets: false });
    }
  });
});
