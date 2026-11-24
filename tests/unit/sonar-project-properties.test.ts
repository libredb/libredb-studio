/**
 * SonarCloud reads workspace packages by the layout of packages/README.md: a package's
 * src/ is source, its tests/ are tests. `packages` is named in both sonar.sources and
 * sonar.tests, which SonarCloud accepts only when no file is both, so the inclusion and
 * exclusion patterns that keep the two sets apart are what this file holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const text = readFileSync(path.resolve(import.meta.dir, "../../sonar-project.properties"), "utf8");

/** The comma-separated values of one property, which the file states once. */
function values(key: string): string[] {
  const lines = text.split("\n").filter((line) => line.startsWith(`${key}=`));
  expect(lines).toHaveLength(1);
  return lines[0]
    .slice(key.length + 1)
    .split(",")
    .map((value) => value.trim());
}

describe("sonar-project.properties and workspace packages", () => {
  test("sonar.sources names src and packages", () => {
    expect(values("sonar.sources")).toEqual(["src", "packages"]);
  });

  test("package tests are Sonar tests and not sources", () => {
    expect(values("sonar.tests")).toContain("packages");
    expect(values("sonar.test.inclusions")).toEqual(
      expect.arrayContaining(["packages/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.tsx"]),
    );
    expect(values("sonar.exclusions")).toContain("packages/*/tests/**");
  });

  test("package tests are excluded from duplication", () => {
    expect(values("sonar.cpd.exclusions")).toContain("packages/*/tests/**");
  });
});
