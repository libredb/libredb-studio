import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read by path: the packages' exports maps do not expose ./package.json.
const ROOT = join(import.meta.dir, "../../../..");

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function installedVersion(name: string): string {
  return String(readJson(`node_modules/${name}/package.json`).version);
}

function atLeast(version: string, floor: string): boolean {
  const [release, prerelease] = version.split("-");
  const have = release.split(".").map(Number);
  const want = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  // A prerelease sorts before its release, so 14.0.3-beta.1 does not meet 14.0.3.
  return prerelease === undefined;
}

describe("passkey dependency floor", () => {
  test("atLeast compares major, minor and patch numerically", () => {
    expect(atLeast("14.0.3", "14.0.3")).toBe(true);
    expect(atLeast("14.0.10", "14.0.3")).toBe(true);
    expect(atLeast("14.1.0", "14.0.3")).toBe(true);
    expect(atLeast("15.0.0", "14.0.3")).toBe(true);
    expect(atLeast("14.0.2", "14.0.3")).toBe(false);
    expect(atLeast("13.9.9", "14.0.3")).toBe(false);
  });

  test("atLeast counts a prerelease of the floor as below it", () => {
    expect(atLeast("14.0.3-beta.1", "14.0.3")).toBe(false);
    expect(atLeast("14.0.4-beta.1", "14.0.3")).toBe(true);
  });

  test("the installed @simplewebauthn/server is at least 14.0.3", () => {
    expect(atLeast(installedVersion("@simplewebauthn/server"), "14.0.3")).toBe(true);
  });

  test("the installed @simplewebauthn/browser is at least 14.0.0", () => {
    expect(atLeast(installedVersion("@simplewebauthn/browser"), "14.0.0")).toBe(true);
  });

  test("package.json asks for those floors", () => {
    const pkg = readJson("package.json") as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const server = readJson("node_modules/@simplewebauthn/server/package.json") as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@simplewebauthn/server"]).toBe("^14.0.3");
    expect(pkg.dependencies["@simplewebauthn/browser"]).toBe("^14.0.0");
    expect(typeof server.dependencies["@peculiar/x509"]).toBe("string");
    expect(pkg.devDependencies["@peculiar/x509"]).toBe(server.dependencies["@peculiar/x509"]);
  });
});
