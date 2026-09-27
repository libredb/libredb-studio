// @requires helm
/**
 * The chart's `mcp` block (#246).
 *
 * The MCP server is off by default, so a default render writes no LIBREDB_MCP_* variable and an
 * install that never mentions MCP renders exactly as before. Enabled, the block writes all four
 * variables as strings, because EnvVar.value is a string and a bare `true` is rejected by the API
 * server. The canonical URL and the token label have no default in the app, and a channel without
 * either accepts no token, so an enabled block without them fails the render and names the value.
 *
 * Exercises real `helm template` output, as helm-chart-agent.test.ts does.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

// Words rather than hex, as helm-chart-agent.test.ts explains: a scanner cannot tell a fixture
// from a credential by its entropy.
const JWT = ["--set", "secrets.jwtSecret=not-a-secret-helm-template-fixture-value"];
const ENABLED = [
  "--set",
  "mcp.enabled=true",
  "--set",
  "mcp.url=https://studio.example.com/api/mcp",
  "--set",
  "mcp.tokenLabel=rotation-one",
];

interface EnvVar {
  name: string;
  value?: string;
}

function helmTemplate(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...JWT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function containerEnv(args: string[] = []): EnvVar[] {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  const deployment = parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as { kind?: string })
    .find((doc) => doc?.kind === "Deployment") as
    | { spec: { template: { spec: { containers: Array<{ env?: EnvVar[] }> } } } }
    | undefined;
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return deployment.spec.template.spec.containers[0].env ?? [];
}

const mcpEntries = (env: EnvVar[]) => env.filter((entry) => entry.name.startsWith("LIBREDB_MCP_"));

describe("a default render", () => {
  test("writes no LIBREDB_MCP_* variable", () => {
    expect(mcpEntries(containerEnv())).toEqual([]);
  });

  test("an older values set with no mcp key at all still renders, with none written", () => {
    expect(mcpEntries(containerEnv(["--set", "mcp=null"]))).toEqual([]);
  });
});

describe("an enabled render", () => {
  test("writes all four variables, each as a string", () => {
    expect(mcpEntries(containerEnv(ENABLED))).toEqual([
      { name: "LIBREDB_MCP_ENABLED", value: "true" },
      { name: "LIBREDB_MCP_URL", value: "https://studio.example.com/api/mcp" },
      { name: "LIBREDB_MCP_TOKEN_LABEL", value: "rotation-one" },
      { name: "LIBREDB_MCP_TOKEN_TTL_DAYS", value: "30" },
    ]);
  });

  test("takes the token lifetime from mcp.tokenTtlDays", () => {
    const env = containerEnv([...ENABLED, "--set", "mcp.tokenTtlDays=7"]);
    expect(env.find((entry) => entry.name === "LIBREDB_MCP_TOKEN_TTL_DAYS")?.value).toBe("7");
  });

  test("writes the variables before extraEnv, so an extraEnv entry of the same name wins", () => {
    const env = containerEnv([
      ...ENABLED,
      "--set",
      "extraEnv[0].name=LIBREDB_MCP_URL",
      "--set",
      "extraEnv[0].value=https://other.example/api/mcp",
    ]);
    const urls = env.map((entry, index) => [entry.name, index] as const).filter(([name]) => name === "LIBREDB_MCP_URL");
    expect(urls).toHaveLength(2);
    expect(env[urls[1][1]].value).toBe("https://other.example/api/mcp");
  });
});

describe("an enabled render that cannot work", () => {
  test.each([
    ["mcp.url", ["--set", "mcp.enabled=true", "--set", "mcp.tokenLabel=rotation-one"]],
    ["mcp.tokenLabel", ["--set", "mcp.enabled=true", "--set", "mcp.url=https://studio.example.com/api/mcp"]],
  ])("fails without %s and names it", (value, args) => {
    const run = helmTemplate(args);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(`${value} is empty`);
  });

  test.each(["0", "366"])("is refused by the schema for mcp.tokenTtlDays=%s", (days) => {
    const run = helmTemplate([...ENABLED, "--set", `mcp.tokenTtlDays=${days}`]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("tokenTtlDays");
  });
});
