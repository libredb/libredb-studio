/**
 * Auth-provider scoping in the chart's secret handling (issue #170).
 *
 * Two invariants, both exercised against real `helm template` output:
 *
 * 1. ADMIN_PASSWORD belongs to the local email/password provider. With
 *    authProvider=oidc the app never reads it, so strict mode must neither
 *    hard-require secrets.adminPassword nor render a non-optional
 *    secretKeyRef for it (an existingSecret built for OIDC has no
 *    admin-password key, and a hard ref keeps the pod from starting).
 *    JWT_SECRET stays required in strict mode for both providers - OIDC
 *    still issues the app's own session cookie.
 *
 * 2. The admin-email key is written only when secrets.adminEmail is set,
 *    like every sibling key. It used to be written unconditionally with an
 *    inline default, which produced a Secret key no pod consumes (the
 *    deployment gates the env on truthiness).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const SECRET_NAME = `${RELEASE}-libredb-studio`;
const STRICT = ["--set", "config.authBootstrap=off"];
const OIDC = ["--set", "authProvider=oidc"];
const JWT = ["--set", "secrets.jwtSecret=0123456789abcdef0123456789abcdef"];

interface EnvVar {
  name: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: { template: { spec: { containers: Array<{ env?: EnvVar[] }> } } };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function render(args: string[]): { secret?: RenderedManifest; deployment: RenderedManifest } {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as RenderedManifest);
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return { secret: docs.find((doc) => doc?.kind === "Secret" && doc.metadata.name === SECRET_NAME), deployment };
}

function env(deployment: RenderedManifest, name: string): EnvVar | undefined {
  return (deployment.spec?.template.spec.containers[0].env ?? []).find((entry) => entry.name === name);
}

describe("strict mode scopes the admin password to the local provider (#170)", () => {
  test("authProvider=oidc renders without secrets.adminPassword", () => {
    const { secret } = render([...STRICT, ...OIDC, ...JWT]);
    expect(secret?.data?.["jwt-secret"]).toBeDefined();
    expect(secret?.data?.["admin-password"]).toBeUndefined();
  });

  test("authProvider=local still demands secrets.adminPassword in strict mode", () => {
    const run = template([...STRICT, ...JWT]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("secrets.adminPassword is required");
  });

  test("jwtSecret stays required in strict mode under oidc", () => {
    const run = template([...STRICT, ...OIDC]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("secrets.jwtSecret is required");
  });

  test("an OIDC existingSecret gets an optional ADMIN_PASSWORD ref, not a hard one", () => {
    const { deployment } = render([...STRICT, ...OIDC, "--set", "secrets.existingSecret=my-oidc-secret"]);
    expect(env(deployment, "ADMIN_PASSWORD")?.valueFrom?.secretKeyRef?.optional).toBe(true);
  });

  test("a local existingSecret keeps the hard ADMIN_PASSWORD ref in strict mode", () => {
    // Strict + local is the one combination where a missing admin password is
    // a deployment error worth surfacing as a pod-start failure.
    const { deployment } = render([...STRICT, "--set", "secrets.existingSecret=my-local-secret"]);
    expect(env(deployment, "ADMIN_PASSWORD")?.valueFrom?.secretKeyRef?.optional).toBeUndefined();
  });
});

describe("the admin-email key follows its siblings (#170)", () => {
  test("emptying secrets.adminEmail writes no key and no env, instead of a key nobody reads", () => {
    const { secret, deployment } = render([
      ...JWT,
      "--set",
      "secrets.adminPassword=test-admin-pass",
      "--set",
      "secrets.adminEmail=",
    ]);
    expect(secret?.data?.["admin-password"]).toBeDefined();
    expect(secret?.data?.["admin-email"]).toBeUndefined();
    expect(env(deployment, "ADMIN_EMAIL")).toBeUndefined();
  });

  test("the default install still carries the chart's documented admin email", () => {
    // values.yaml mirrors the app's own fallback (src/lib/local-auth.ts), so the
    // default install must keep rendering it - the gate above is for an explicit "".
    const { secret } = render([...JWT, "--set", "secrets.adminPassword=test-admin-pass"]);
    expect(Buffer.from(secret?.data?.["admin-email"] ?? "", "base64").toString()).toBe("admin@libredb.org");
  });

  test("setting secrets.adminEmail writes the key and the env that consumes it", () => {
    const { secret, deployment } = render([
      ...JWT,
      "--set",
      "secrets.adminPassword=test-admin-pass",
      "--set",
      "secrets.adminEmail=ops@example.com",
    ]);
    expect(Buffer.from(secret?.data?.["admin-email"] ?? "", "base64").toString()).toBe("ops@example.com");
    expect(env(deployment, "ADMIN_EMAIL")?.valueFrom?.secretKeyRef?.key).toBe("admin-email");
  });
});
