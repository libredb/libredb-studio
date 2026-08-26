/**
 * config.authCookieSecure is three-state (backlog N2).
 *
 * AUTH_COOKIE_SECURE is the operator's answer for a browser reaching Studio over
 * plain http on a host that is not loopback: the browser rejects a Secure cookie
 * and login silently loops. Until chart 0.1.52 it was reachable only through
 * extraEnv, which made the setting most likely to be needed on a LAN or
 * home-server install the one not discoverable from values.yaml.
 *
 * The invariant these cases exist to protect is that **unset writes nothing**.
 * `false` is the value that matters here, so the template cannot use the
 * `{{- if .Values.config.X }}` truthiness its string siblings use - that would
 * silently drop it. It tests `kindIs "invalid"` instead, and these cases pin all
 * three arms plus the schema that keeps a mis-spelled string from arriving as a
 * value the app would read as unset.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

/** The rendered ConfigMap's data map. */
function configMapData(args: string[]): Record<string, string> {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as RenderedManifest);
  const configMap = docs.find((doc) => doc?.kind === "ConfigMap" && doc.metadata.name.endsWith("-config"));
  if (!configMap) throw new Error("no ConfigMap manifest found in rendered chart output");
  return configMap.data ?? {};
}

describe("config.authCookieSecure renders three-state (N2)", () => {
  test("unset writes no AUTH_COOKIE_SECURE, leaving the app's own default in place", () => {
    expect(configMapData([])).not.toHaveProperty("AUTH_COOKIE_SECURE");
  });

  test("an explicit null is the same as unset", () => {
    expect(configMapData(["--set", "config.authCookieSecure=null"])).not.toHaveProperty("AUTH_COOKIE_SECURE");
  });

  test("false is written - the arm a truthiness condition would have dropped", () => {
    expect(configMapData(["--set", "config.authCookieSecure=false"]).AUTH_COOKIE_SECURE).toBe("false");
  });

  test("true is written", () => {
    expect(configMapData(["--set", "config.authCookieSecure=true"]).AUTH_COOKIE_SECURE).toBe("true");
  });

  test("a string spelling is refused by the schema rather than read as unset", () => {
    const run = template(["--set-string", "config.authCookieSecure=off"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("/config/authCookieSecure");
  });

  test("values.yaml documents the key so it is discoverable without the README", async () => {
    const values = await Bun.file(join(CHART_DIR, "values.yaml")).text();
    expect(values).toContain("authCookieSecure: null");
  });
});
