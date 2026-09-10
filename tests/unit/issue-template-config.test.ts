import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../..");
const readConfig = () => parse(readFileSync(path.join(ROOT, ".github/ISSUE_TEMPLATE/config.yml"), "utf8"));

describe("issue template contacts", () => {
  test("keeps blank issues available explicitly", () => {
    expect(readConfig().blank_issues_enabled).toBe(true);
  });

  test("routes questions to Discussions and vulnerabilities to the private reporting policy", () => {
    const links = readConfig().contact_links;
    expect(links).toHaveLength(2);
    expect(links.map((link: { url: string }) => link.url)).toEqual([
      "https://github.com/libredb/libredb-studio/discussions",
      "https://github.com/libredb/libredb-studio/blob/main/SECURITY.md#reporting-a-vulnerability",
    ]);
    for (const link of links) {
      expect(link.name.trim().length).toBeGreaterThan(0);
      expect(link.about.trim().length).toBeGreaterThan(0);
    }
    const securityPolicy = readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
    expect(securityPolicy).toContain("## Reporting a Vulnerability");
    expect(securityPolicy).toContain("Please do not report security vulnerabilities through public GitHub issues.");
  });
});
