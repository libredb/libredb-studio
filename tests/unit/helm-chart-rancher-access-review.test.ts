// @requires helm
/**
 * The chart's access review values (accessReview), the second half of Rancher mode.
 *
 * Enabled, the chart switches the Kubernetes access review on (docs/SEED_CONNECTIONS.md, "Kubernetes access review"):
 * it names Studio's own Deployment as the admin review's target, grants Studio's ServiceAccount one right, create on
 * subjectaccessreviews, and mounts a short-lived projected token with the cluster's CA for the reviews only, so the
 * pod's own token mount stays off. Every combination Studio's boot check refuses with the review on fails the render
 * instead, naming the value to fix.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "libredb-studio";
const NAMESPACE = "libredb-studio";
const REVIEW_DIR = "/var/run/secrets/libredb/access-review";
const BINDING_NAME = "libredb-studio.libredb-studio-access-review";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

interface ProjectedSource {
  serviceAccountToken?: { path: string; expirationSeconds: number; audience?: string };
  configMap?: { name: string; items: Array<{ key: string; path: string }> };
}

interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  containers: Array<{
    env?: EnvVar[];
    volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  }>;
  volumes?: Array<{ name: string; projected?: { sources: ProjectedSource[] } }>;
}

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  rules?: unknown[];
  roleRef?: unknown;
  subjects?: unknown[];
  spec?: { template?: { spec: PodSpec } };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", NAMESPACE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function render(args: string[]): Manifest[] {
  const run = template(args);
  if (run.exitCode !== 0) throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as Manifest)
    .filter(Boolean);
}

function refused(args: string[], ...needles: string[]): void {
  const run = template(args);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
}

function pod(docs: Manifest[]): PodSpec {
  const deployment = docs.find((doc) => doc.kind === "Deployment" && !doc.metadata.name.endsWith("-discovery"));
  const spec = deployment?.spec?.template?.spec;
  if (!spec) throw new Error("no Studio pod spec");
  return spec;
}

function env(docs: Manifest[]): EnvVar[] {
  return pod(docs).containers[0].env ?? [];
}

function envMap(docs: Manifest[]): Record<string, string | undefined> {
  return Object.fromEntries(env(docs).map((entry) => [entry.name, entry.value]));
}

/** The values a Rancher-mode install sets beside the review: OIDC and a session of at most 900 seconds. */
const BASE = [
  "--set",
  "authProvider=oidc",
  "--set",
  "config.oidcIssuer=https://rancher.example.com/oidc",
  "--set",
  "config.sessionTtlSeconds=900",
];
const ON = [...BASE, "--set", "accessReview.enabled=true"];

describe("accessReview is off by default", () => {
  test("the default install renders no ClusterRole, binding, projected token or variable", () => {
    const docs = render([]);
    expect(docs.some((doc) => doc.kind === "ClusterRole" || doc.kind === "ClusterRoleBinding")).toBe(false);
    expect(pod(docs).volumes?.some((volume) => volume.name === "access-review")).toBe(false);
    expect(env(docs).some((entry) => entry.name.startsWith("KUBERNETES_ACCESS_REVIEW"))).toBe(false);
  });

  test("values.yaml carries the block off", async () => {
    const values = await Bun.file(join(CHART_DIR, "values.yaml")).text();
    expect(values).toMatch(
      /accessReview:\n(?:\s*#.*\n)*\s+enabled: false[\s\S]*?cacheSeconds: null[\s\S]*?signIn: ""[\s\S]*?tokenExpirationSeconds: 3600/,
    );
  });
});

describe("accessReview.enabled", () => {
  test("grants Studio's ServiceAccount create on subjectaccessreviews and nothing else", () => {
    const docs = render(ON);
    const role = docs.find((doc) => doc.kind === "ClusterRole");
    expect(role?.metadata.name).toBe(BINDING_NAME);
    expect(role?.rules).toEqual([
      { apiGroups: ["authorization.k8s.io"], resources: ["subjectaccessreviews"], verbs: ["create"] },
    ]);
    const binding = docs.find((doc) => doc.kind === "ClusterRoleBinding");
    expect(binding?.metadata.name).toBe(BINDING_NAME);
    expect(binding?.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: BINDING_NAME,
    });
    expect(binding?.subjects).toEqual([{ kind: "ServiceAccount", name: "libredb-studio", namespace: NAMESPACE }]);
  });

  test("binds the account the pod runs as, a named one included", () => {
    const docs = render([...ON, "--set", "serviceAccount.create=false", "--set", "serviceAccount.name=studio-sa"]);
    const binding = docs.find((doc) => doc.kind === "ClusterRoleBinding");
    expect(binding?.subjects).toEqual([{ kind: "ServiceAccount", name: "studio-sa", namespace: NAMESPACE }]);
    expect(pod(docs).serviceAccountName).toBe("studio-sa");
  });

  test("mounts a projected token and the cluster CA read-only, and keeps the pod's own token mount off", () => {
    const docs = render(ON);
    const spec = pod(docs);
    expect(spec.automountServiceAccountToken).toBe(false);
    const volume = spec.volumes?.find((entry) => entry.name === "access-review");
    expect(volume?.projected?.sources).toEqual([
      { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
      { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
    ]);
    const mount = spec.containers[0].volumeMounts?.find((entry) => entry.name === "access-review");
    expect(mount).toEqual({ name: "access-review", mountPath: REVIEW_DIR, readOnly: true });
  });

  test("writes the switch, the admin Deployment and the token and CA paths", () => {
    expect(envMap(render(ON))).toMatchObject({
      KUBERNETES_ACCESS_REVIEW: "on",
      KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT: `${NAMESPACE}/libredb-studio`,
      KUBERNETES_ACCESS_REVIEW_TOKEN_PATH: `${REVIEW_DIR}/token`,
      KUBERNETES_ACCESS_REVIEW_CA_PATH: `${REVIEW_DIR}/ca.crt`,
    });
    const names = env(render(ON)).map((entry) => entry.name);
    expect(names).not.toContain("KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS");
    expect(names).not.toContain("KUBERNETES_ACCESS_REVIEW_SIGN_IN");
  });

  test("the admin Deployment follows fullnameOverride", () => {
    expect(envMap(render([...ON, "--set", "fullnameOverride=studio"])).KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT).toBe(
      `${NAMESPACE}/studio`,
    );
  });

  test("cacheSeconds, signIn and tokenExpirationSeconds are written as set, 0 included", () => {
    const docs = render([
      ...ON,
      "--set",
      "accessReview.cacheSeconds=0",
      "--set",
      "accessReview.signIn=get services/libredb-studio -n libredb-studio",
      "--set",
      "accessReview.tokenExpirationSeconds=900",
    ]);
    expect(envMap(docs).KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS).toBe("0");
    expect(envMap(docs).KUBERNETES_ACCESS_REVIEW_SIGN_IN).toBe("get services/libredb-studio -n libredb-studio");
    const volume = pod(docs).volumes?.find((entry) => entry.name === "access-review");
    expect(volume?.projected?.sources[0].serviceAccountToken?.expirationSeconds).toBe(900);
  });

  test("cacheSeconds above 60 and a token under ten minutes are refused by the schema", () => {
    refused([...ON, "--set", "accessReview.cacheSeconds=61"], "cacheSeconds");
    refused([...ON, "--set", "accessReview.tokenExpirationSeconds=60"], "tokenExpirationSeconds");
  });

  test("writes no password variable from secrets.existingSecret, which the boot check would refuse", () => {
    const names = env(render([...ON, "--set", "secrets.existingSecret=studio-secrets"])).map((entry) => entry.name);
    expect(names).not.toContain("ADMIN_PASSWORD");
    expect(names).not.toContain("USER_EMAIL");
    expect(names).not.toContain("USER_PASSWORD");
    expect(names).toContain("JWT_SECRET");
  });
});

describe("access review guards", () => {
  test("authProvider other than oidc fails", () => {
    refused(
      ["--set", "accessReview.enabled=true", "--set", "config.sessionTtlSeconds=900"],
      "accessReview.enabled requires authProvider=oidc",
    );
  });

  test("config.oidcRoleClaim fails", () => {
    refused([...ON, "--set", "config.oidcRoleClaim=groups"], "config.oidcRoleClaim");
  });

  test("mcp.enabled fails", () => {
    refused(
      [
        ...ON,
        "--set",
        "mcp.enabled=true",
        "--set",
        "mcp.url=https://studio.example.com/api/mcp",
        "--set",
        "mcp.tokenLabel=a",
      ],
      "accessReview.enabled refuses mcp.enabled",
    );
  });

  test("agent.enabled=true fails, false renders", () => {
    refused([...ON, "--set", "agent.enabled=true"], "accessReview.enabled refuses agent.enabled=true");
    expect(envMap(render([...ON, "--set", "agent.enabled=false"])).LIBREDB_AGENT_ENABLED).toBe("false");
  });

  test("governance fails", () => {
    refused([...ON, "--set", "governance.enabled=true"], "accessReview.enabled refuses governance.enabled");
  });

  test("an inline admin or user password fails", () => {
    refused([...ON, "--set", "secrets.adminPassword=not-a-real-password"], "secrets.adminPassword");
    refused([...ON, "--set", "secrets.userPassword=not-a-real-password"], "secrets.userPassword");
  });

  test("a session lifetime unset or above 900 seconds fails", () => {
    refused([...BASE.slice(0, 4), "--set", "accessReview.enabled=true"], "config.sessionTtlSeconds");
    refused(
      [...BASE.slice(0, 4), "--set", "accessReview.enabled=true", "--set", "config.sessionTtlSeconds=901"],
      "config.sessionTtlSeconds",
    );
    expect(
      envMap(
        render([...BASE.slice(0, 4), "--set", "accessReview.enabled=true", "--set", "config.sessionTtlSeconds=300"]),
      ),
    ).toHaveProperty("KUBERNETES_ACCESS_REVIEW");
  });

  test("more than one replica or autoscaling fails", () => {
    const jwt = ["--set", "secrets.jwtSecret=not-a-real-secret-0123456789abcdef"];
    refused([...ON, ...jwt, "--set", "replicaCount=2"], "one replica");
    refused([...ON, ...jwt, "--set", "autoscaling.enabled=true"], "one replica");
  });

  test("the namespace's default ServiceAccount is refused", () => {
    refused([...ON, "--set", "serviceAccount.create=false"], "serviceAccount");
  });

  test("an extraEnv entry named KUBERNETES_ACCESS_REVIEW* fails", () => {
    refused(
      [
        ...ON,
        "--set",
        "extraEnv[0].name=KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
        "--set-string",
        "extraEnv[0].value=5",
      ],
      "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
    );
  });

  test("the full Rancher-mode set renders: review, discovery, NavLink, OIDC Secret, custom connections off", () => {
    const docs = render([
      ...ON,
      "--set",
      "secrets.oidcExistingSecret=libredb-studio-oidc",
      "--set",
      "config.oidcScope=openid profile groups",
      "--set",
      "config.oidcPrompt=omit",
      "--set",
      "config.oidcAutoRedirect=true",
      "--set",
      "config.allowCustomConnections=false",
      "--set",
      "agent.enabled=false",
      "--set",
      "seedConnections.cacheTTL=10000",
      "--set",
      "accessReview.cacheSeconds=15",
      "--set",
      "discovery.kubernetes.enabled=true",
      "--set",
      "discovery.kubernetes.namespaces={team-a}",
      "--set",
      "rancher.navLink.enabled=true",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hosts[0].host=studio.example.com",
      "--api-versions",
      "ui.cattle.io/v1/NavLink",
    ]);
    expect(docs.some((doc) => doc.kind === "NavLink")).toBe(true);
    expect(docs.some((doc) => doc.kind === "ClusterRoleBinding")).toBe(true);
    expect(envMap(docs)).toMatchObject({ KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS: "15", SEED_CACHE_TTL_MS: "10000" });
  });
});
