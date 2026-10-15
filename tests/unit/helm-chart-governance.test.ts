// @requires helm
/**
 * The chart's `governance` block (docs/HELM_CHART.md#11-governance).
 *
 * Off by default, so a default render writes no GOVERNANCE_* variable, mounts no keyring and keeps the readiness
 * probe on /api/db/health: an install that never mentions governance renders exactly as before. Enabled, the
 * ConfigMap carries GOVERNANCE_SOURCE=postgres and the other non-secret values, the governance URL comes from the
 * chart's Secret or from secrets.existingSecret, and the keyring is a read-only file mounted from the same Secret,
 * never an environment variable. The render guards mirror the boot preflight, so a values set that Studio would
 * refuse to start with fails the render instead, naming the value to fix.
 *
 * Exercises real `helm template` output, as helm-chart-mcp.test.ts does.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const FULLNAME = `${RELEASE}-libredb-studio`;
const KEYRING_DIR = "/etc/libredb/governance";
const KEYRING_FILE = `${KEYRING_DIR}/keyring.json`;

// Words rather than hex, as helm-chart-agent.test.ts explains: a scanner cannot tell a fixture
// from a credential by its entropy.
const JWT = ["--set", "secrets.jwtSecret=not-a-secret-helm-template-fixture-value"];

/** `--set` arguments for each `key=value`. */
const sets = (...pairs: string[]) => pairs.flatMap((pair) => ["--set", pair]);

/** A governance install as the installer writes it, without its secret values. */
const GOVERNED_VALUES = [
  "governance.enabled=true",
  "authProvider=oidc",
  "config.oidcIssuer=https://auth.example.com/realms/libredb",
  "config.oidcRoleClaim=libredb_roles",
  "config.oidcUserRoles=user",
  "config.storageProvider=postgres",
  "config.storagePostgresSchema=studio",
];

/** The install with the URL and the keyring inline, in the chart's own Secret. */
const GOVERNED = sets(
  ...GOVERNED_VALUES,
  "secrets.storagePostgresUrl=postgresql://studio-storage-fixture@db.example.com/libredb",
  "secrets.governancePostgresUrl=postgresql://studio-governance-fixture@db.example.com/libredb",
  "secrets.governancePrivateKeys=keyring-document-fixture",
);

/** The same install with every secret value in an operator's Secret instead. */
const GOVERNED_EXISTING_SECRET = sets(...GOVERNED_VALUES, "secrets.existingSecret=studio-installer-secret");

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string; optional?: boolean };
    fieldRef?: { fieldPath: string };
  };
}

interface Probe {
  httpGet?: { path: string };
}

interface Container {
  env?: EnvVar[];
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
  startupProbe?: Probe;
}

interface Volume {
  name: string;
  secret?: { secretName: string; defaultMode?: number; items?: Array<{ key: string; path: string }> };
}

interface Manifest {
  kind?: string;
  metadata?: { name: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
  spec?: {
    template?: { spec: { containers: Container[]; volumes?: Volume[] } };
  };
}

function helmTemplate(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...JWT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

interface Rendered {
  manifests: Manifest[];
  configMap: Record<string, string>;
  secret: Manifest | undefined;
  container: Container;
  env: EnvVar[];
  volumes: Volume[];
}

function render(args: string[] = []): Rendered {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  const manifests = parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as Manifest | null)
    .filter((doc): doc is Manifest => doc !== null);
  const deployment = manifests.find((doc) => doc.kind === "Deployment");
  if (!deployment?.spec?.template) throw new Error("no Deployment manifest found in rendered chart output");
  const configMap = manifests.find((doc) => doc.kind === "ConfigMap" && doc.metadata?.name === `${FULLNAME}-config`);
  if (!configMap?.data) throw new Error("no chart ConfigMap found in rendered chart output");
  const container = deployment.spec.template.spec.containers[0];
  return {
    manifests,
    configMap: configMap.data,
    secret: manifests.find((doc) => doc.kind === "Secret" && doc.metadata?.name === FULLNAME),
    container,
    env: container.env ?? [],
    volumes: deployment.spec.template.spec.volumes ?? [],
  };
}

/** Asserts the render fails, and returns its error output. */
function renderFails(args: string[]): string {
  const run = helmTemplate(args);
  expect(run.exitCode).not.toBe(0);
  return run.stderr;
}

const envNamed = (env: EnvVar[], name: string) => env.find((entry) => entry.name === name);
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** Every mount of the container at or under the keyring's directory. */
const keyringMounts = (container: Container) =>
  (container.volumeMounts ?? []).filter((mount) => mount.mountPath === KEYRING_DIR || mount.mountPath === KEYRING_FILE);

describe("a default render", () => {
  test("a default render contains no GOVERNANCE_ variable", () => {
    const { configMap, env, container, volumes } = render();

    expect(Object.keys(configMap).filter((key) => key.startsWith("GOVERNANCE_"))).toEqual([]);
    expect(env.filter((entry) => entry.name.startsWith("GOVERNANCE_"))).toEqual([]);
    expect(keyringMounts(container)).toEqual([]);
    expect(volumes.some((volume) => volume.name === "governance-keyring")).toBe(false);
    expect(container.readinessProbe?.httpGet?.path).toBe("/api/db/health");
  });

  test("writes none of the new OIDC, session or storage variables while they are unset", () => {
    const { configMap } = render(["--set", "authProvider=oidc"]);

    for (const key of [
      "OIDC_USER_ROLES",
      "OIDC_PROMPT",
      "OIDC_AUTO_REDIRECT",
      "OIDC_LOGOUT_HINT",
      "AUTH_SESSION_TTL_SECONDS",
      "STORAGE_POSTGRES_SCHEMA",
    ]) {
      expect(configMap[key]).toBeUndefined();
    }
  });
});

describe("an older values set", () => {
  test("with no governance or stickySessions key at all still renders, with no GOVERNANCE_ variable", () => {
    const { configMap, env } = render(sets("governance=null", "stickySessions=null"));

    expect(Object.keys(configMap).filter((key) => key.startsWith("GOVERNANCE_"))).toEqual([]);
    expect(env.filter((entry) => entry.name.startsWith("GOVERNANCE_"))).toEqual([]);
  });
});

describe("helm lint --strict", () => {
  /** Lints the chart with `values` as a values file, which --strict checks against values.schema.json. */
  function lint(values: string): { exitCode: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "helm-chart-governance-"));
    try {
      const file = join(dir, "values.yaml");
      writeFileSync(file, values);
      const run = Bun.spawnSync(["helm", "lint", CHART_DIR, "--strict", "-f", file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("passes with a governance values file", () => {
    const run = lint(
      [
        "authProvider: oidc",
        "governance:",
        "  enabled: true",
        "  refreshMs: 15000",
        "config:",
        '  authBootstrap: "off"',
        "  oidcIssuer: https://auth.example.com/realms/libredb",
        "  oidcRoleClaim: libredb_roles",
        "  oidcUserRoles: user",
        "  oidcPrompt: omit",
        "  oidcAutoRedirect: true",
        "  oidcLogoutHint: true",
        "  sessionTtlSeconds: 28800",
        "  storageProvider: postgres",
        "  storagePostgresSchema: studio",
        "secrets:",
        "  existingSecret: libredb-studio",
        "",
      ].join("\n"),
    );

    expect(run.output).toContain("0 chart(s) failed");
    expect(run.exitCode).toBe(0);
  });

  test("refuses an OIDC prompt the app does not know", () => {
    expect(lint("config:\n  oidcPrompt: none\n").exitCode).not.toBe(0);
  });
});

describe("the new OIDC, session and storage values", () => {
  test("render whenever they are set, governance or not", () => {
    const { configMap } = render([
      "--set",
      "authProvider=oidc",
      "--set",
      "config.oidcUserRoles=user",
      "--set",
      "config.oidcPrompt=omit",
      "--set",
      "config.oidcAutoRedirect=true",
      "--set",
      "config.oidcLogoutHint=true",
      "--set",
      "config.sessionTtlSeconds=28800",
      "--set",
      "config.storagePostgresSchema=studio",
    ]);

    expect(configMap.OIDC_USER_ROLES).toBe("user");
    expect(configMap.OIDC_PROMPT).toBe("omit");
    expect(configMap.OIDC_AUTO_REDIRECT).toBe("true");
    expect(configMap.OIDC_LOGOUT_HINT).toBe("true");
    expect(configMap.AUTH_SESSION_TTL_SECONDS).toBe("28800");
    expect(configMap.STORAGE_POSTGRES_SCHEMA).toBe("studio");
  });
});

describe("governance.enabled", () => {
  test("governance.enabled renders GOVERNANCE_SOURCE=postgres, the URL secretKeyRef and the keyring file mount with mode 0400", () => {
    const { configMap, env, container, volumes, secret } = render(GOVERNED);

    expect(configMap.GOVERNANCE_SOURCE).toBe("postgres");
    expect(configMap.GOVERNANCE_POSTGRES_SCHEMA).toBe("bridge");
    expect(configMap.GOVERNANCE_PRIVATE_KEYS_FILE).toBe(KEYRING_FILE);
    // Optional values stay unset, so the app keeps its own defaults.
    expect(configMap.GOVERNANCE_REFRESH_MS).toBeUndefined();
    expect(configMap.GOVERNANCE_MAX_STALENESS_MS).toBeUndefined();
    expect(configMap.GOVERNANCE_ALLOWED_ENGINES).toBeUndefined();

    expect(envNamed(env, "GOVERNANCE_POSTGRES_URL")).toEqual({
      name: "GOVERNANCE_POSTGRES_URL",
      valueFrom: { secretKeyRef: { name: FULLNAME, key: "governance-postgres-url" } },
    });
    expect(secret?.data?.["governance-postgres-url"]).toBe(
      b64("postgresql://studio-governance-fixture@db.example.com/libredb"),
    );
    expect(secret?.data?.["governance-private-keys"]).toBe(b64("keyring-document-fixture"));

    // The keyring is a file, never a variable.
    expect(env.some((entry) => entry.name === "GOVERNANCE_PRIVATE_KEYS")).toBe(false);
    expect(JSON.stringify(env)).not.toContain("governance-private-keys");
    expect(keyringMounts(container)).toEqual([{ name: "governance-keyring", mountPath: KEYRING_DIR, readOnly: true }]);
    expect(volumes.find((volume) => volume.name === "governance-keyring")).toEqual({
      name: "governance-keyring",
      secret: {
        secretName: FULLNAME,
        // 0400: readable by the owner only; the kubelet adds group read for fsGroup 1001, the group uid 1001 reads it through.
        defaultMode: 0o400,
        items: [{ key: "governance-private-keys", path: "keyring.json" }],
      },
    });

    // Readiness moves to /api/ready, liveness stays on the path that depends on nothing.
    expect(container.readinessProbe?.httpGet?.path).toBe("/api/ready");
    expect(container.livenessProbe?.httpGet?.path).toBe("/api/db/health");
    expect(container.startupProbe?.httpGet?.path).toBe("/api/db/health");
  });

  test("the readiness probe keeps config.basePath in front of /api/ready", () => {
    const { container } = render([...GOVERNED, "--set", "config.basePath=/studio"]);

    expect(container.readinessProbe?.httpGet?.path).toBe("/studio/api/ready");
  });

  test("renders the optional governance values when they are set", () => {
    const { configMap } = render([
      ...GOVERNED,
      "--set",
      "governance.postgresSchema=bridge_v1",
      "--set",
      "governance.refreshMs=15000",
      "--set",
      "governance.maxStalenessMs=90000",
      "--set-string",
      "governance.allowedEngines=postgres\\,mysql",
    ]);

    expect(configMap.GOVERNANCE_POSTGRES_SCHEMA).toBe("bridge_v1");
    expect(configMap.GOVERNANCE_REFRESH_MS).toBe("15000");
    expect(configMap.GOVERNANCE_MAX_STALENESS_MS).toBe("90000");
    expect(configMap.GOVERNANCE_ALLOWED_ENGINES).toBe("postgres,mysql");
  });

  test("with secrets.existingSecret the URL and the keyring come from its keys governance-postgres-url and governance-private-keys, and exactly one volume mounts the keyring path", () => {
    const { env, container, volumes, secret } = render(GOVERNED_EXISTING_SECRET);

    expect(secret).toBeUndefined();
    expect(envNamed(env, "GOVERNANCE_POSTGRES_URL")?.valueFrom?.secretKeyRef).toEqual({
      name: "studio-installer-secret",
      key: "governance-postgres-url",
    });
    expect(keyringMounts(container)).toHaveLength(1);
    const keyringVolumes = volumes.filter((volume) => volume.name === keyringMounts(container)[0].name);
    expect(keyringVolumes).toHaveLength(1);
    expect(keyringVolumes[0].secret?.secretName).toBe("studio-installer-secret");
    expect(keyringVolumes[0].secret?.items).toEqual([{ key: "governance-private-keys", path: "keyring.json" }]);
  });

  test("an existingSecret's mapped keys are honoured", () => {
    const { env, volumes } = render([
      ...GOVERNED_EXISTING_SECRET,
      "--set",
      "secrets.existingSecretKeys.governancePostgresUrl=bridge-url",
      "--set",
      "secrets.existingSecretKeys.governancePrivateKeys=bridge-keyring",
    ]);

    expect(envNamed(env, "GOVERNANCE_POSTGRES_URL")?.valueFrom?.secretKeyRef?.key).toBe("bridge-url");
    expect(volumes.find((volume) => volume.name === "governance-keyring")?.secret?.items).toEqual([
      { key: "bridge-keyring", path: "keyring.json" },
    ]);
  });

  test("an existingSecret never reaches ADMIN_PASSWORD, USER_EMAIL or USER_PASSWORD, which the preflight refuses", () => {
    const { env } = render(GOVERNED_EXISTING_SECRET);

    for (const name of ["ADMIN_PASSWORD", "USER_EMAIL", "USER_PASSWORD", "SEED_CONFIG_PATH"]) {
      expect(envNamed(env, name)).toBeUndefined();
    }
  });

  test("with one replica GOVERNANCE_INSTANCE_ID is the chart fullname, not the pod name", () => {
    const { env, configMap } = render(GOVERNED);

    expect(envNamed(env, "GOVERNANCE_INSTANCE_ID")).toEqual({ name: "GOVERNANCE_INSTANCE_ID", value: FULLNAME });
    expect(configMap.GOVERNANCE_INSTANCE_ID).toBeUndefined();
  });

  test("with one replica a set governance.instanceId is the instance id", () => {
    const { env } = render([...GOVERNED, "--set", "governance.instanceId=libredb-studio"]);

    expect(envNamed(env, "GOVERNANCE_INSTANCE_ID")).toEqual({
      name: "GOVERNANCE_INSTANCE_ID",
      value: "libredb-studio",
    });
  });

  test("stickySessions.enabled lets two replicas render with the pod name as instance id and adds no ingress annotation", () => {
    const { env, manifests } = render([
      ...GOVERNED,
      "--set",
      "replicaCount=2",
      "--set",
      "stickySessions.enabled=true",
      "--set",
      "ingress.enabled=true",
    ]);

    expect(envNamed(env, "GOVERNANCE_INSTANCE_ID")).toEqual({
      name: "GOVERNANCE_INSTANCE_ID",
      valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
    });
    const ingress = manifests.find((doc) => doc.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress?.metadata?.annotations ?? {}).toEqual({});
  });

  test("stickySessions.enabled with autoscaling renders the pod name as instance id", () => {
    const { env } = render([...GOVERNED, "--set", "autoscaling.enabled=true", "--set", "stickySessions.enabled=true"]);

    expect(envNamed(env, "GOVERNANCE_INSTANCE_ID")?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.name");
  });
});

describe("the governance render guards", () => {
  test("governance.enabled with authProvider local fails naming authProvider", () => {
    expect(renderFails([...GOVERNED, "--set", "authProvider=local"])).toContain("authProvider");
  });

  test("governance.enabled with replicaCount 2 and no stickySessions fails naming replicaCount", () => {
    const stderr = renderFails([...GOVERNED, "--set", "replicaCount=2"]);
    expect(stderr).toContain("replicaCount");
    expect(stderr).toContain("stickySessions.enabled");
  });

  test("governance.enabled with autoscaling and no stickySessions fails naming autoscaling.enabled", () => {
    expect(renderFails([...GOVERNED, "--set", "autoscaling.enabled=true"])).toContain("autoscaling.enabled");
  });

  test("more than one replica with a set governance.instanceId fails naming governance.instanceId", () => {
    const stderr = renderFails([
      ...GOVERNED,
      "--set",
      "replicaCount=2",
      "--set",
      "stickySessions.enabled=true",
      "--set",
      "governance.instanceId=libredb-studio",
    ]);
    expect(stderr).toContain("governance.instanceId");
  });

  test("governance.enabled with an extraEnv entry named GOVERNANCE_SOURCE fails naming extraEnv", () => {
    const stderr = renderFails([
      ...GOVERNED,
      "--set",
      "extraEnv[0].name=GOVERNANCE_SOURCE",
      "--set",
      "extraEnv[0].value=postgres",
    ]);
    expect(stderr).toContain("extraEnv");
    expect(stderr).toContain("GOVERNANCE_SOURCE");
  });

  test.each([
    ["config.oidcRoleClaim", ["--set", "config.oidcRoleClaim="]],
    ["config.oidcUserRoles", ["--set", "config.oidcUserRoles="]],
    ["config.storagePostgresSchema", ["--set", "config.storagePostgresSchema="]],
    ["secrets.governancePostgresUrl", ["--set", "secrets.governancePostgresUrl="]],
    ["secrets.governancePrivateKeys", ["--set", "secrets.governancePrivateKeys="]],
    ["seedConnections.enabled", ["--set", "seedConnections.enabled=true", "--set", "seedConnections.config.a=b"]],
    [
      "mcp.enabled",
      ["--set", "mcp.enabled=true", "--set", "mcp.url=https://s.example.com/api/mcp", "--set", "mcp.tokenLabel=one"],
    ],
    ["agent.enabled", ["--set", "agent.enabled=true"]],
    ["secrets.adminPassword", ["--set", "secrets.adminPassword=fixture-admin-password"]],
    ["secrets.userPassword", ["--set", "secrets.userPassword=fixture-user-password"]],
    ["podSecurityContext.fsGroup", ["--set", "podSecurityContext.fsGroup=null"]],
  ])("governance.enabled fails naming %s", (name, args) => {
    expect(renderFails([...GOVERNED, ...args])).toContain(name);
  });

  test("agent.enabled=false is no refusal: it switches the agent off", () => {
    expect(() => render([...GOVERNED, "--set", "agent.enabled=false"])).not.toThrow();
  });

  test("an extraEnv entry with another name still renders", () => {
    const { env } = render([
      ...GOVERNED,
      "--set",
      "extraEnv[0].name=NODE_EXTRA_CA_CERTS",
      "--set",
      "extraEnv[0].value=/ca.crt",
    ]);

    expect(envNamed(env, "NODE_EXTRA_CA_CERTS")?.value).toBe("/ca.crt");
  });
});
