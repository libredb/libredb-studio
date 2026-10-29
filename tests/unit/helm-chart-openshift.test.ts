// @requires helm
/**
 * Regression tests for the chart-0.1.20 OpenShift and seed-connection
 * behaviors introduced with the operator PR (#152):
 *
 *   1. global.compatibility.openshift.adaptSecurityContext drops the fixed
 *      runAsUser/runAsGroup/fsGroup (keeping runAsNonRoot and the seccomp
 *      profile) when the target is OpenShift - "auto" detects via the
 *      security.openshift.io/v1 API group, "force" always adapts,
 *      "disabled" never does. OpenShift's restricted-v2 SCC rejects pods
 *      that hard-code IDs outside the namespace range, so this is what
 *      makes the operator's default CR installable there.
 *   2. seedConnections.enabled with neither inline config nor an
 *      existingConfigMap fails the render (previously the Deployment
 *      mounted a ConfigMap that was never rendered and pods failed at
 *      startup); each supported source still renders.
 *
 * Exercises the real `helm template` output against the actual chart - no
 * reimplementation of the templating logic (same approach as
 * helm-chart-hardening.test.ts). OpenShift detection is simulated with
 * `--api-versions security.openshift.io/v1`, which feeds
 * .Capabilities.APIVersions exactly like a live API server would.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

const OPENSHIFT_API = ["--api-versions", "security.openshift.io/v1"];

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  spec?: {
    template?: {
      spec?: {
        securityContext?: Record<string, unknown>;
        volumes?: Array<{ name: string; configMap?: { name: string } }>;
      };
    };
  };
}

function helmTemplate(
  args: string[],
  chartDir: string = CHART_DIR,
): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", chartDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function renderDocs(args: string[]): RenderedManifest[] {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter((doc) => doc != null);
}

function appPodSecurityContext(docs: RenderedManifest[]): Record<string, unknown> {
  const deployment = docs.find((doc) => doc.kind === "Deployment");
  const psc = deployment?.spec?.template?.spec?.securityContext;
  if (!psc) {
    throw new Error("Deployment pod securityContext not found in render output");
  }
  return psc;
}

describe("charts/libredb-studio OpenShift adaptation (#152)", () => {
  test("vanilla default keeps the fixed UID/GID fields", () => {
    const psc = appPodSecurityContext(renderDocs([]));
    expect(psc.runAsUser).toBe(1001);
    expect(psc.runAsGroup).toBe(1001);
    expect(psc.fsGroup).toBe(1001);
    expect(psc.runAsNonRoot).toBe(true);
  });

  test("auto drops only the fixed UID/GID fields when the API server is OpenShift", () => {
    const psc = appPodSecurityContext(renderDocs(OPENSHIFT_API));
    expect(psc.runAsUser).toBeUndefined();
    expect(psc.runAsGroup).toBeUndefined();
    expect(psc.fsGroup).toBeUndefined();
    expect(psc.runAsNonRoot).toBe(true);
    expect(psc.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  test("force drops the fixed UID/GID fields without OpenShift API detection", () => {
    const psc = appPodSecurityContext(
      renderDocs(["--set", "global.compatibility.openshift.adaptSecurityContext=force"]),
    );
    expect(psc.runAsUser).toBeUndefined();
    expect(psc.runAsGroup).toBeUndefined();
    expect(psc.fsGroup).toBeUndefined();
    expect(psc.runAsNonRoot).toBe(true);
  });

  test("disabled keeps the fixed UID/GID fields even on OpenShift", () => {
    const psc = appPodSecurityContext(
      renderDocs([...OPENSHIFT_API, "--set", "global.compatibility.openshift.adaptSecurityContext=disabled"]),
    );
    expect(psc.runAsUser).toBe(1001);
    expect(psc.runAsGroup).toBe(1001);
    expect(psc.fsGroup).toBe(1001);
  });

  test("an unknown adaptSecurityContext value fails schema validation", () => {
    const run = helmTemplate(["--set", "global.compatibility.openshift.adaptSecurityContext=maybe"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("adaptSecurityContext");
  });
});

describe("charts/libredb-studio seedConnections source guard (#152)", () => {
  test("enabled with neither inline config nor existingConfigMap fails the render", () => {
    const run = helmTemplate(["--set", "seedConnections.enabled=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("seedConnections");
  });

  test("enabled with inline config renders the chart ConfigMap and mounts it", () => {
    const docs = renderDocs([
      "--set",
      "seedConnections.enabled=true",
      "--set-json",
      'seedConnections.config={"connections":[]}',
    ]);
    const seedConfigMap = docs.find(
      (doc) => doc.kind === "ConfigMap" && doc.metadata.name.endsWith("-seed-connections"),
    );
    expect(seedConfigMap).toBeDefined();
    const volumes = docs.find((doc) => doc.kind === "Deployment")?.spec?.template?.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "seed-config")?.configMap?.name).toBe(seedConfigMap?.metadata.name);
  });

  test("enabled with existingConfigMap renders no chart ConfigMap and mounts the existing one", () => {
    const docs = renderDocs([
      "--set",
      "seedConnections.enabled=true",
      "--set",
      "seedConnections.existingConfigMap=my-seeds",
    ]);
    expect(
      docs.find((doc) => doc.kind === "ConfigMap" && doc.metadata.name.endsWith("-seed-connections")),
    ).toBeUndefined();
    const volumes = docs.find((doc) => doc.kind === "Deployment")?.spec?.template?.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "seed-config")?.configMap?.name).toBe("my-seeds");
  });
});

/**
 * The subchart-dependent contracts: the same global adapts the bundled
 * PostgreSQL StatefulSet (the pinned subchart honours
 * global.compatibility.openshift.adaptSecurityContext), and every subchart
 * image is redirected to docker.io/bitnamilegacy (the docker.io/bitnami
 * originals were removed by Broadcom's catalog freeze - a subchart update
 * that reverts either contract must fail here, not as ImagePullBackOff or
 * an SCC rejection on a user cluster).
 *
 * postgresql.enabled=true renders require the vendored dependency
 * (charts/postgresql-*.tgz is gitignored), so it is vendored on demand -
 * fails loudly when that is impossible rather than silently skipping.
 */
describe("charts/libredb-studio PostgreSQL subchart contracts (#152)", () => {
  /**
   * A private copy of the chart, because vendoring writes: `helm dependency build` drops
   * `charts/postgresql-*.tgz` and rewrites `Chart.lock`. Doing that in `charts/libredb-studio`
   * mutated the repository working tree, which a drift guard running beside the suite sees, and
   * with several test files rendering that one directory at once, a file reading it mid-write
   * gets a render failure that has nothing to do with what it asserts. Helm's repository config
   * and cache are redirected into the copy for the same reason: `helm repo add` otherwise edits
   * one shared file under the contributor's home directory.
   */
  let pgChartDir: string;
  let helmHome: string;

  beforeAll(() => {
    helmHome = mkdtempSync(join(tmpdir(), "libredb-helm-openshift-"));
    pgChartDir = join(helmHome, "libredb-studio");
    cpSync(CHART_DIR, pgChartDir, { recursive: true });

    const vendored =
      existsSync(join(pgChartDir, "charts")) &&
      readdirSync(join(pgChartDir, "charts")).some((f) => f.startsWith("postgresql-") && f.endsWith(".tgz"));
    if (vendored) {
      return;
    }
    // Only a clone that has never vendored the subchart reaches the network here.
    const helmEnv = {
      ...process.env,
      HELM_REPOSITORY_CONFIG: join(helmHome, "repositories.yaml"),
      HELM_REPOSITORY_CACHE: join(helmHome, "cache"),
    };
    const repoAdd = Bun.spawnSync(
      ["helm", "repo", "add", "bitnami", "https://charts.bitnami.com/bitnami", "--force-update"],
      { stdout: "pipe", stderr: "pipe", env: helmEnv },
    );
    const depBuild = Bun.spawnSync(["helm", "dependency", "build", pgChartDir], {
      stdout: "pipe",
      stderr: "pipe",
      env: helmEnv,
    });
    if (repoAdd.exitCode !== 0 || depBuild.exitCode !== 0) {
      // Both children are named, because either can be the one that failed and a kill writes
      // nothing to stderr: without the clause this read "dependency:  " and named neither.
      throw new Error(
        `could not vendor the postgresql subchart dependency: ` +
          `helm repo add ${howItFailed(repoAdd)}: ${repoAdd.stderr.toString()}; ` +
          `helm dependency build ${howItFailed(depBuild)}: ${depBuild.stderr.toString()}`,
      );
    }
  });

  afterAll(() => {
    rmSync(helmHome, { recursive: true, force: true });
  });

  const PG_ARGS = ["--set", "postgresql.enabled=true", "--set", "postgresql.auth.password=test-pg-pass"];

  function statefulSetSource(args: string[]): string {
    const run = helmTemplate([...PG_ARGS, ...args], pgChartDir);
    if (run.exitCode !== 0) {
      throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
    }
    const statefulSet = run.stdout
      .split("---")
      .find((doc) => doc.includes("kind: StatefulSet") && doc.includes("postgresql"));
    if (!statefulSet) {
      throw new Error("postgresql StatefulSet not found in render output");
    }
    return statefulSet;
  }

  test("force drops the subchart's fixed UID/GID fields too", () => {
    const statefulSet = statefulSetSource(["--set", "global.compatibility.openshift.adaptSecurityContext=force"]);
    expect(statefulSet).not.toContain("runAsUser:");
    expect(statefulSet).not.toContain("fsGroup:");
  });

  test("auto drops the subchart's fixed UID/GID fields when the API server is OpenShift", () => {
    const statefulSet = statefulSetSource(OPENSHIFT_API);
    expect(statefulSet).not.toContain("runAsUser:");
    expect(statefulSet).not.toContain("fsGroup:");
  });

  test("disabled keeps the subchart's fixed UID/GID fields", () => {
    const statefulSet = statefulSetSource(["--set", "global.compatibility.openshift.adaptSecurityContext=disabled"]);
    expect(statefulSet).toContain("runAsUser: 1001");
    expect(statefulSet).toContain("fsGroup: 1001");
  });

  test("every subchart image is pulled from bitnamilegacy (none from the frozen bitnami namespace)", () => {
    const run = helmTemplate([
      ...PG_ARGS,
      "--set",
      "postgresql.volumePermissions.enabled=true",
      "--set",
      "postgresql.metrics.enabled=true",
    ]);
    expect(run.exitCode).toBe(0);
    const images = [...run.stdout.matchAll(/image:\s*"?([^"\s]+)"?/g)].map((m) => m[1]);
    const subchartImages = images.filter((image) => !image.startsWith("ghcr.io/libredb/"));
    expect(subchartImages.length).toBeGreaterThanOrEqual(3); // postgresql, os-shell, postgres-exporter
    for (const image of subchartImages) {
      expect(image).toStartWith("docker.io/bitnamilegacy/");
    }
  });
});

/**
 * One switch for every OpenShift-only object the chart renders: "auto" asks
 * .Capabilities.APIVersions for the API each object needs, "force" treats every
 * OpenShift API as served, for a GitOps or offline `helm template` that has no
 * cluster to ask. It is separate from adaptSecurityContext, which speaks only of
 * the pod security context.
 */
describe("charts/libredb-studio OpenShift API detection switch", () => {
  test("an unknown global.compatibility.openshift.apis value fails schema validation", () => {
    const run = helmTemplate(["--set", "global.compatibility.openshift.apis=maybe"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("apis");
  });

  test("apis=force is accepted and changes nothing while every OpenShift object is off", () => {
    expect(renderDocs(["--set", "global.compatibility.openshift.apis=force"])).toEqual(renderDocs([]));
  });

  test("a values set without the openshift blocks renders as before", () => {
    expect(renderDocs(["--set", "openshift=null", "--set", "openshiftRoute=null"])).toEqual(renderDocs([]));
  });
});

/**
 * A NetworkPolicy is matched after the service address is rewritten to the
 * endpoint, so on OpenShift DNS goes out on 5353 (the CoreDNS pods' port behind
 * the dns-default Service's 53) and the API server on 6443 (behind
 * kubernetes.default.svc's 443). Sign-in, self reviews and discovery all reach
 * * the API server there.
 */
describe("charts/libredb-studio NetworkPolicy on OpenShift", () => {
  const POLICY = ["--set", "networkPolicy.enabled=true"];

  interface EgressRule {
    ports?: Array<{ port: number; protocol: string }>;
  }

  function egressRules(args: string[]): EgressRule[] {
    const policy = renderDocs([...POLICY, ...args]).find((doc) => doc.kind === "NetworkPolicy") as unknown as {
      spec: { egress: EgressRule[] };
    };
    return policy.spec.egress;
  }

  function egressPorts(args: string[]): Array<{ port: number; protocol: string }> {
    return egressRules(args).flatMap((rule) => rule.ports ?? []);
  }

  test("a vanilla render keeps today's egress ports", () => {
    const ports = egressPorts([]).map((entry) => entry.port);
    expect(ports).not.toContain(5353);
    expect(ports).not.toContain(6443);
  });

  test("OpenShift adds UDP and TCP 5353 and TCP 6443 beside 53 and 443", () => {
    const ports = egressPorts(OPENSHIFT_API);
    for (const expected of [
      { port: 5353, protocol: "UDP" },
      { port: 5353, protocol: "TCP" },
      { port: 6443, protocol: "TCP" },
      { port: 53, protocol: "UDP" },
      { port: 53, protocol: "TCP" },
      { port: 443, protocol: "TCP" },
    ]) {
      expect(ports).toContainEqual(expected);
    }
  });

  test("apis=force adds the same ports without detection", () => {
    const ports = egressPorts(["--set", "global.compatibility.openshift.apis=force"]);
    expect(ports).toContainEqual({ port: 5353, protocol: "UDP" });
    expect(ports).toContainEqual({ port: 5353, protocol: "TCP" });
    expect(ports).toContainEqual({ port: 6443, protocol: "TCP" });
  });

  test("6443 appears in exactly one egress rule when the access review is also on", () => {
    const rules = egressRules([
      ...OPENSHIFT_API,
      "--set",
      "authProvider=oidc",
      "--set",
      "config.oidcIssuer=https://rancher.example.com/oidc",
      "--set",
      "config.sessionTtlSeconds=900",
      "--set",
      "accessReview.enabled=true",
    ]);
    const with6443 = rules.filter((rule) => (rule.ports ?? []).some((entry) => entry.port === 6443));
    expect(with6443).toHaveLength(1);
    expect(with6443[0].ports?.filter((entry) => entry.port === 6443)).toHaveLength(1);
  });
});

/**
 * openshift.trustedCABundle: an empty ConfigMap labelled for the Cluster Network
 * Operator, which fills it with the cluster's trusted CA bundle (the proxy's
 * trustedCA plus the system roots), mounted without items or subPath so the
 * kubelet refreshes the file once injected, and named by NODE_EXTRA_CA_CERTS.
 */
describe("charts/libredb-studio OpenShift trusted CA bundle", () => {
  const CONFIG_API = ["--api-versions", "config.openshift.io/v1"];
  const ENABLED = ["--set", "openshift.trustedCABundle.enabled=true"];
  const BUNDLE_DIR = "/etc/libredb-studio/trusted-ca";

  interface PodSpec {
    containers: Array<{
      env?: Array<{ name: string; value?: string }>;
      volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
    }>;
    volumes?: Array<{ name: string; configMap?: { name: string; items?: unknown } }>;
  }

  interface Manifest {
    kind: string;
    metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    data?: unknown;
    spec?: { template?: { spec?: PodSpec } };
  }

  const docs = (args: string[]) => renderDocs(args) as unknown as Manifest[];
  const trustedCaConfigMap = (rendered: Manifest[]) =>
    rendered.find(
      (doc) => doc.kind === "ConfigMap" && doc.metadata.name === "release-under-test-libredb-studio-trusted-ca",
    );
  const podSpec = (rendered: Manifest[]): PodSpec => {
    const spec = rendered.find((doc) => doc.kind === "Deployment")?.spec?.template?.spec;
    if (!spec) throw new Error("Deployment pod spec not found in render output");
    return spec;
  };

  test("default values render no trusted-CA ConfigMap", () => {
    for (const args of [[], CONFIG_API]) {
      const rendered = docs(args);
      expect(trustedCaConfigMap(rendered)).toBeUndefined();
      const pod = podSpec(rendered);
      expect(pod.volumes?.map((volume) => volume.name)).not.toContain("trusted-ca");
      expect(pod.containers[0].env?.map((entry) => entry.name)).not.toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  test("the trusted-CA ConfigMap carries the injection label and no data", () => {
    const configMap = trustedCaConfigMap(docs([...CONFIG_API, ...ENABLED]));
    expect(configMap).toBeDefined();
    expect(configMap?.metadata.labels?.["config.openshift.io/inject-trusted-cabundle"]).toBe("true");
    expect(configMap?.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    expect(configMap?.data).toBeUndefined();
    expect(configMap?.metadata.annotations ?? {}).not.toHaveProperty("service.beta.openshift.io/inject-cabundle");
  });

  test("the bundle is mounted read-only and named by NODE_EXTRA_CA_CERTS", () => {
    const pod = podSpec(docs([...CONFIG_API, ...ENABLED]));
    const container = pod.containers[0];
    expect(container.volumeMounts?.find((mount) => mount.name === "trusted-ca")).toEqual({
      name: "trusted-ca",
      mountPath: BUNDLE_DIR,
      readOnly: true,
    });
    expect(pod.volumes?.find((volume) => volume.name === "trusted-ca")).toEqual({
      name: "trusted-ca",
      configMap: { name: "release-under-test-libredb-studio-trusted-ca" },
    });
    expect(container.env?.find((entry) => entry.name === "NODE_EXTRA_CA_CERTS")).toEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: `${BUNDLE_DIR}/ca-bundle.crt`,
    });
  });

  test("an extraEnv NODE_EXTRA_CA_CERTS conflicts with the trusted bundle", () => {
    const run = helmTemplate([
      ...CONFIG_API,
      ...ENABLED,
      "--set",
      "extraEnv[0].name=NODE_EXTRA_CA_CERTS",
      "--set",
      "extraEnv[0].value=/x",
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshift.trustedCABundle.enabled");
    expect(run.stderr).toContain("NODE_EXTRA_CA_CERTS");
  });

  test("an extraEnv NODE_EXTRA_CA_CERTS without the trusted bundle still renders", () => {
    const pod = podSpec(docs(["--set", "extraEnv[0].name=NODE_EXTRA_CA_CERTS", "--set", "extraEnv[0].value=/x"]));
    expect(pod.containers[0].env?.filter((entry) => entry.name === "NODE_EXTRA_CA_CERTS")).toEqual([
      { name: "NODE_EXTRA_CA_CERTS", value: "/x" },
    ]);
  });

  test("without config.openshift.io/v1 the trusted bundle fails the render and names the force switch", () => {
    const run = helmTemplate([...OPENSHIFT_API, ...ENABLED]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshift.trustedCABundle.enabled");
    expect(run.stderr).toContain("config.openshift.io/v1");
    expect(run.stderr).toContain("global.compatibility.openshift.apis=force");
  });

  test("apis=force renders it without detection", () => {
    const rendered = docs([...ENABLED, "--set", "global.compatibility.openshift.apis=force"]);
    expect(trustedCaConfigMap(rendered)).toBeDefined();
    expect(podSpec(rendered).volumes?.map((volume) => volume.name)).toContain("trusted-ca");
  });

  test("the trusted-ca volume name is unique beside governance and access review volumes", () => {
    const governance = [
      "--set",
      "governance.enabled=true",
      "--set",
      "authProvider=oidc",
      "--set",
      "config.oidcIssuer=https://auth.example.com/realms/libredb",
      "--set",
      "config.oidcRoleClaim=libredb_roles",
      "--set",
      "config.oidcUserRoles=user",
      "--set",
      "config.storageProvider=postgres",
      "--set",
      "config.storagePostgresSchema=studio",
      "--set",
      "secrets.existingSecret=studio-installer-secret",
    ];
    const accessReview = [
      "--set",
      "authProvider=oidc",
      "--set",
      "config.oidcIssuer=https://rancher.example.com/oidc",
      "--set",
      "config.sessionTtlSeconds=900",
      "--set",
      "accessReview.enabled=true",
    ];
    for (const [args, other] of [
      [governance, "governance-keyring"],
      [accessReview, "access-review"],
    ] as const) {
      const pod = podSpec(docs([...CONFIG_API, ...ENABLED, ...args]));
      const volumes = (pod.volumes ?? []).map((volume) => volume.name);
      const mounts = (pod.containers[0].volumeMounts ?? []).map((mount) => mount.name);
      expect(volumes).toContain(other);
      expect(volumes.filter((name) => name === "trusted-ca")).toHaveLength(1);
      expect(mounts.filter((name) => name === "trusted-ca")).toHaveLength(1);
      expect(new Set(volumes).size).toBe(volumes.length);
      expect(new Set(mounts).size).toBe(mounts.length);
    }
  });

  test("an unknown openshift.trustedCABundle key fails schema validation", () => {
    const run = helmTemplate([...CONFIG_API, "--set", "openshift.trustedCABundle.enable=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("trustedCABundle");
  });
});
