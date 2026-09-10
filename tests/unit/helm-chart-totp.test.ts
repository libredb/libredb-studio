/**
 * TOTP second-factor wiring in the chart.
 *
 * The property that matters is that the secret travels as a Secret. `extraEnv` could already
 * deliver ADMIN_TOTP_SECRET before this wiring existed, but it writes the literal value into the
 * Deployment's pod spec, where anyone with `get deployments` can read it — an MFA feature whose
 * only Helm path leaks the shared secret to a wider audience than the password it protects is
 * worse than none. Everything else here follows from MFA being opt-in per account: neither key
 * may ever be required, and neither may appear when it was not asked for.
 *
 * Exercised against real `helm template` output, like the sibling chart tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { RFC6238_SECRET } from "../helpers/rfc6238";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const SECRET_NAME = `${RELEASE}-libredb-studio`;

/** RFC 6238's Appendix B seed, reused here purely as a known-good base32 string. */
const SECRET = RFC6238_SECRET;

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: { template: { spec: { containers: Array<{ env?: EnvVar[] }> } } };
}

function renderChart(extraArgs: string[] = []): { secret?: RenderedManifest; env: EnvVar[] } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const docs = parseAllDocuments(run.stdout.toString()).map((doc) => doc.toJSON() as RenderedManifest);
  const secret = docs.find((doc) => doc?.kind === "Secret" && doc.metadata.name === SECRET_NAME);
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return { secret, env: deployment.spec?.template.spec.containers[0].env ?? [] };
}

function envVar(env: EnvVar[], name: string): EnvVar | undefined {
  return env.find((entry) => entry.name === name);
}

describe("charts/libredb-studio TOTP second factor", () => {
  test("writes neither key nor env when no TOTP secret is configured", () => {
    const { secret, env } = renderChart();

    expect(Object.keys(secret?.data ?? {})).not.toContain("admin-totp-secret");
    expect(envVar(env, "ADMIN_TOTP_SECRET")).toBeUndefined();
    expect(envVar(env, "USER_TOTP_SECRET")).toBeUndefined();
  });

  test("carries the admin secret through the Secret, never inline in the pod spec", () => {
    const { secret, env } = renderChart(["--set", `secrets.adminTotpSecret=${SECRET}`]);

    expect(secret?.data?.["admin-totp-secret"]).toBe(Buffer.from(SECRET).toString("base64"));

    const rendered = envVar(env, "ADMIN_TOTP_SECRET");
    expect(rendered?.valueFrom?.secretKeyRef).toMatchObject({ name: SECRET_NAME, key: "admin-totp-secret" });
    // The decisive assertion: the literal secret is nowhere in the Deployment.
    expect(rendered?.value).toBeUndefined();
  });

  test("keeps each account's secret independent", () => {
    const { secret, env } = renderChart([
      "--set",
      "secrets.userPassword=user-secret",
      "--set",
      `secrets.userTotpSecret=${SECRET}`,
    ]);

    expect(secret?.data?.["user-totp-secret"]).toBe(Buffer.from(SECRET).toString("base64"));
    expect(envVar(env, "USER_TOTP_SECRET")?.valueFrom?.secretKeyRef?.key).toBe("user-totp-secret");
    expect(envVar(env, "ADMIN_TOTP_SECRET")).toBeUndefined();
  });

  test("marks both refs optional even in strict mode, because MFA is opt-in", () => {
    // Strict mode is where a hard secretKeyRef would keep the pod from starting. A second
    // factor the operator never asked for must not be able to do that.
    const { env } = renderChart([
      "--set",
      "config.authBootstrap=off",
      "--set",
      "secrets.jwtSecret=not-a-secret-helm-template-fixture-value",
      "--set",
      "secrets.adminPassword=admin-secret",
      "--set",
      `secrets.adminTotpSecret=${SECRET}`,
    ]);

    expect(envVar(env, "ADMIN_TOTP_SECRET")?.valueFrom?.secretKeyRef?.optional).toBe(true);
  });

  test("references both keys under an existingSecret so a pre-provisioned one can carry them", () => {
    const { env } = renderChart(["--set", "secrets.existingSecret=byo-auth"]);

    expect(envVar(env, "ADMIN_TOTP_SECRET")?.valueFrom?.secretKeyRef).toMatchObject({
      name: "byo-auth",
      key: "admin-totp-secret",
      // Optional is what lets an existingSecret predating MFA keep working untouched.
      optional: true,
    });
    expect(envVar(env, "USER_TOTP_SECRET")?.valueFrom?.secretKeyRef?.name).toBe("byo-auth");
  });

  test("rejects a secret that is not base32 at install time, not at first login", () => {
    // values.schema.json is the only place this can be caught before the pod runs; without it
    // the operator learns about the typo from a 503 on the login screen.
    const run = Bun.spawnSync(
      ["helm", "template", RELEASE, CHART_DIR, "--set", "secrets.adminTotpSecret=not-base32!"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("adminTotpSecret");
  });
});
