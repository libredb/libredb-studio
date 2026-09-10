import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = join(import.meta.dir, "../../charts/libredb-studio");
function render(args: string[] = []) {
  const result = Bun.spawnSync(["helm", "template", "base-path-test", chart, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString(), error: result.stderr.toString() };
}
function container(output: string) {
  const documents = parseAllDocuments(output).map((document) => document.toJSON());
  return documents.find((document) => document?.kind === "Deployment").spec.template.spec.containers[0];
}

describe("chart probes for a build-time basePath", () => {
  test("root remains the default", () => {
    const result = render();
    expect(result.code).toBe(0);
    for (const name of ["startupProbe", "readinessProbe", "livenessProbe"]) {
      expect(container(result.output)[name].httpGet.path).toBe("/api/db/health");
    }
  });
  for (const prefix of ["/libredb", "/tools/libredb", "/~/libredb"]) {
    test(`${prefix} prefixes each default probe without changing custom probes`, () => {
      const result = render(["--set-string", `config.basePath=${prefix}`]);
      expect(result.code).toBe(0);
      for (const name of ["startupProbe", "readinessProbe", "livenessProbe"]) {
        expect(container(result.output)[name].httpGet.path).toBe(`${prefix}/api/db/health`);
      }
      expect(result.output).not.toMatch(/name: BASE_PATH|BASE_PATH:/);
      const custom = render([
        "--set-string",
        `config.basePath=${prefix}`,
        "--set-string",
        "readinessProbe.httpGet.path=/custom-health",
      ]);
      expect(container(custom.output).readinessProbe.httpGet.path).toBe("/custom-health");
    });
  }
  for (const prefix of ["//outside", "/a/../b", "/a/", "/%2f", "/a?x"]) {
    test(`rejects malformed prefix ${prefix}`, () => {
      const result = render(["--set-string", `config.basePath=${prefix}`]);
      expect(result.code).not.toBe(0);
      expect(result.error).toContain("basePath");
    });
  }
  test("custom exec probes stay exact", () => {
    const result = render([
      "--set-string",
      "config.basePath=/tools/libredb",
      "--set",
      "readinessProbe.httpGet=null",
      "--set",
      "readinessProbe.exec.command[0]=true",
    ]);
    expect(result.code).toBe(0);
    expect(container(result.output).readinessProbe.httpGet).toBeUndefined();
    expect(container(result.output).readinessProbe.exec).toBeDefined();
  });
});
