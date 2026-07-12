/**
 * Regression test for issue #136: the documented minimal Helm install
 * (only secrets.jwtSecret + secrets.adminPassword) must render cleanly -
 * the non-admin user password is optional (the app never assumes one), so
 * the secret template must not hard-require secrets.userPassword, and
 * neither the user-password secret key nor the USER_PASSWORD env may
 * render while it is unset. Exercises the real `helm template` output
 * against the actual chart - no reimplementation of the templating logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

const MINIMAL_ARGS = [
  "--set",
  "secrets.jwtSecret=0123456789abcdef0123456789abcdef",
  "--set",
  "secrets.adminPassword=test-admin-pass",
];

interface EnvVar {
  name: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: {
    template: {
      spec: {
        containers: Array<{ env: EnvVar[] }>;
      };
    };
  };
}

function renderChart(extraArgs: string[] = []): { secret: RenderedManifest; deployment: RenderedManifest } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...MINIMAL_ARGS, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const docs = parseAllDocuments(run.stdout.toString()).map((doc) => doc.toJSON() as RenderedManifest);
  const secret = docs.find(
    (doc) => doc?.kind === "Secret" && doc.metadata.name === "release-under-test-libredb-studio",
  );
  if (!secret) throw new Error("no chart Secret manifest found in rendered output");
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return { secret, deployment };
}

function containerEnv(deployment: RenderedManifest): EnvVar[] {
  return deployment.spec?.template.spec.containers[0].env ?? [];
}

describe("charts/libredb-studio optional user password (#136)", () => {
  test("minimal two-secret install renders with no user-password secret key and no USER_PASSWORD env", () => {
    const { secret, deployment } = renderChart();

    const secretKeys = Object.keys(secret.data ?? {});
    expect(secretKeys).not.toContain("user-password");
    expect(secretKeys).not.toContain("user-email");

    const env = containerEnv(deployment);
    expect(env.find((e) => e.name === "USER_PASSWORD")).toBeUndefined();
    expect(env.find((e) => e.name === "USER_EMAIL")).toBeUndefined();
  });

  test("setting secrets.userPassword renders both the secret keys and the env wiring", () => {
    const { secret, deployment } = renderChart(["--set", "secrets.userPassword=test-user-pass"]);

    expect(secret.data?.["user-password"]).toBe(Buffer.from("test-user-pass").toString("base64"));
    expect(secret.data?.["user-email"]).toBeDefined();

    const env = containerEnv(deployment);
    expect(env.find((e) => e.name === "USER_PASSWORD")?.valueFrom?.secretKeyRef?.key).toBe("user-password");
    expect(env.find((e) => e.name === "USER_EMAIL")?.valueFrom?.secretKeyRef?.key).toBe("user-email");
  });
});
