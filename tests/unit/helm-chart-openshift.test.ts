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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
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

  /**
   * The OpenShift console's Topology view draws an arrow from the Studio
   * Deployment to the bundled PostgreSQL when the Deployment names it in
   * app.openshift.io/connects-to, a JSON array of {apiVersion, kind, name}
   * (probe OP19). Only the bundled subchart is a workload the chart knows.
   */
  const CONNECTS_TO = "app.openshift.io/connects-to";

  interface Workload {
    kind: string;
    metadata: { name: string; annotations?: Record<string, string> };
  }

  function studioDeployment(args: string[], chartDir: string): Workload & { statefulSets: string[] } {
    const run = helmTemplate(args, chartDir);
    if (run.exitCode !== 0) {
      throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
    }
    const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as Workload);
    const deployment = docs.find((doc) => doc?.kind === "Deployment");
    if (!deployment) {
      throw new Error("Studio Deployment not found in render output");
    }
    const statefulSets = docs.filter((doc) => doc?.kind === "StatefulSet").map((doc) => doc.metadata.name);
    return { ...deployment, statefulSets };
  }

  test("connects-to is absent by default and with postgresql disabled", () => {
    for (const args of [[], ["--set", "postgresql.enabled=false"], OPENSHIFT_API]) {
      expect(studioDeployment(args, pgChartDir).metadata.annotations ?? {}).not.toHaveProperty(CONNECTS_TO);
    }
  });

  test("connects-to names the bundled PostgreSQL StatefulSet when it is enabled", () => {
    const deployment = studioDeployment(PG_ARGS, pgChartDir);
    expect(deployment.metadata.annotations?.[CONNECTS_TO]).toBe(
      '[{"apiVersion":"apps/v1","kind":"StatefulSet","name":"release-under-test-postgresql"}]',
    );
    expect(deployment.statefulSets).toEqual(["release-under-test-postgresql"]);
  });

  test("connects-to follows the subchart's name, not the Studio nameOverride or fullnameOverride", () => {
    for (const override of [
      ["--set", "nameOverride=studio"],
      ["--set", "fullnameOverride=studio"],
      ["--set", "nameOverride=studio", "--set", "fullnameOverride=studio-app"],
    ]) {
      const deployment = studioDeployment([...PG_ARGS, ...override], pgChartDir);
      const [target] = JSON.parse(deployment.metadata.annotations?.[CONNECTS_TO] ?? "[]") as Array<
        Record<string, string>
      >;
      expect(target).toEqual({ apiVersion: "apps/v1", kind: "StatefulSet", name: "release-under-test-postgresql" });
      expect(deployment.statefulSets).toEqual([target?.name]);
    }
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
 * the API server there.
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

/**
 * Topology in the OpenShift console groups workloads by app.kubernetes.io/part-of
 * and picks the node icon from app.openshift.io/runtime. Both are opt-in, so a
 * default render is unchanged, and land on every Deployment the chart renders
 * and on its pod template, never on a selector.
 */
describe("charts/libredb-studio OpenShift Topology labels", () => {
  const PART_OF = "app.kubernetes.io/part-of";
  const RUNTIME = "app.openshift.io/runtime";
  const TOPOLOGY = ["--set", "openshift.topology.partOf=libredb", "--set", "openshift.topology.runtime=nodejs"];
  const DISCOVERY = [
    "--set",
    "discovery.kubernetes.enabled=true",
    "--set",
    "discovery.kubernetes.namespaces={team-a,team-b}",
  ];

  interface Deployment {
    kind: string;
    metadata: { name: string; labels: Record<string, string> };
    spec: {
      selector: { matchLabels: Record<string, string> };
      template: { metadata: { labels: Record<string, string> } };
    };
  }

  const deployments = (args: string[]) =>
    (renderDocs(args) as unknown as Deployment[]).filter((doc) => doc.kind === "Deployment");
  const studio = (list: Deployment[]) => list.find((doc) => doc.metadata.name === "release-under-test-libredb-studio");
  const discovery = (list: Deployment[]) => {
    const found = list.find((doc) => doc.metadata.name !== "release-under-test-libredb-studio");
    if (!found) throw new Error("discovery Deployment not found in render output");
    return found;
  };
  const noTopology = (deployment: Deployment | undefined) => {
    for (const labels of [deployment?.metadata.labels, deployment?.spec.template.metadata.labels]) {
      expect(labels ?? {}).not.toHaveProperty(PART_OF);
      expect(labels ?? {}).not.toHaveProperty(RUNTIME);
    }
  };
  const withTopology = (deployment: Deployment | undefined) => {
    for (const labels of [deployment?.metadata.labels, deployment?.spec.template.metadata.labels]) {
      expect(labels?.[PART_OF]).toBe("libredb");
      expect(labels?.[RUNTIME]).toBe("nodejs");
    }
  };

  test("default values add no Topology label", () => {
    noTopology(studio(deployments([])));
    noTopology(studio(deployments(OPENSHIFT_API)));
  });

  test("partOf and runtime land on the Deployment and its pod template", () => {
    const before = studio(deployments([]));
    const after = studio(deployments(TOPOLOGY));
    withTopology(after);
    expect(after?.spec.selector.matchLabels).toEqual(before?.spec.selector.matchLabels);
  });

  test("each Topology label renders on its own", () => {
    const partOfOnly = studio(deployments(["--set", "openshift.topology.partOf=libredb"]));
    expect(partOfOnly?.metadata.labels[PART_OF]).toBe("libredb");
    expect(partOfOnly?.metadata.labels).not.toHaveProperty(RUNTIME);
    const runtimeOnly = studio(deployments(["--set", "openshift.topology.runtime=nodejs"]));
    expect(runtimeOnly?.metadata.labels[RUNTIME]).toBe("nodejs");
    expect(runtimeOnly?.metadata.labels).not.toHaveProperty(PART_OF);
  });

  test("partOf and runtime also land on the discovery Deployment and its pod template", () => {
    const before = discovery(deployments(DISCOVERY));
    noTopology(before);
    const after = discovery(deployments([...DISCOVERY, ...TOPOLOGY]));
    withTopology(after);
    expect(after.spec.selector.matchLabels).toEqual(before.spec.selector.matchLabels);
  });

  test("a values set without the openshift block renders no Topology label", () => {
    const list = deployments([...DISCOVERY, "--set", "openshift=null"]);
    expect(list).toHaveLength(2);
    for (const deployment of list) noTopology(deployment);
  });

  test("an unknown openshift.topology key fails schema validation", () => {
    const run = helmTemplate(["--set", "openshift.topology.group=libredb"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("topology");
  });

  test("a Topology label that podLabels also sets fails the render and names both values", () => {
    for (const [value, key, podValue] of [
      ["openshift.topology.partOf=libredb", "app.kubernetes.io/part-of", "other"],
      ["openshift.topology.runtime=nodejs", "app.openshift.io/runtime", "nodejs"],
    ]) {
      const escaped = key.replaceAll(".", "\\.");
      const run = helmTemplate(["--set", value, "--set", `podLabels.${escaped}=${podValue}`]);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain(value);
      expect(run.stderr).toContain(`podLabels ${key}=${podValue}`);
    }
  });

  test("podLabels beside the Topology labels still render once each", () => {
    const pod = studio(deployments([...TOPOLOGY, "--set", "podLabels.team=data"]))?.spec.template.metadata.labels;
    expect(pod?.[PART_OF]).toBe("libredb");
    expect(pod?.team).toBe("data");
    const fromPodLabelsOnly = studio(deployments(["--set", "podLabels.app\\.kubernetes\\.io/part-of=x"]));
    expect(fromPodLabelsOnly?.spec.template.metadata.labels[PART_OF]).toBe("x");
  });

  test("a Topology value that is not a valid label value fails schema validation", () => {
    for (const key of ["partOf", "runtime"]) {
      for (const bad of ["lib redb", "-libredb", `a${"b".repeat(63)}`]) {
        const run = helmTemplate(["--set", `openshift.topology.${key}=${bad}`]);
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain(key);
      }
    }
    const longest = studio(deployments(["--set", `openshift.topology.partOf=${"a".repeat(63)}`]));
    expect(longest?.metadata.labels[PART_OF]).toBe("a".repeat(63));
  });
});

/**
 * The OpenShift console's Helm catalog and the chart verifier read the
 * charts.openshift.io/* annotations, and a chart without a `helm test` hook
 * fails the verifier's chart-testing check. The hook pod runs Studio's own
 * image (node is already there) against the health route through the Service,
 * under the same security context and scheduling as the Deployment.
 */
describe("charts/libredb-studio OpenShift catalog annotations and helm test hook", () => {
  interface PodSpec {
    serviceAccountName?: string;
    imagePullSecrets?: unknown;
    nodeSelector?: unknown;
    tolerations?: unknown;
    restartPolicy?: string;
    automountServiceAccountToken?: boolean;
    securityContext?: Record<string, unknown>;
    containers: Array<{
      image: string;
      command?: string[];
      args?: string[];
      resources?: unknown;
      securityContext?: Record<string, unknown>;
    }>;
  }

  interface Manifest {
    kind: string;
    metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    spec?: PodSpec & { selector?: Record<string, string>; template?: { spec: PodSpec } };
  }

  const HOOK_NAME = "release-under-test-libredb-studio-test-health";
  const docs = (args: string[]) => renderDocs(args) as unknown as Manifest[];
  const hookPods = (rendered: Manifest[]) => rendered.filter((doc) => doc.kind === "Pod");
  const hookPod = (rendered: Manifest[]) => {
    const pods = hookPods(rendered);
    if (pods.length !== 1) throw new Error(`expected one hook Pod, rendered ${pods.length}`);
    return pods[0];
  };
  const deploymentPod = (rendered: Manifest[]): PodSpec => {
    const spec = rendered.find((doc) => doc.kind === "Deployment")?.spec?.template?.spec;
    if (!spec) throw new Error("Deployment pod spec not found in render output");
    return spec;
  };
  const commandLine = (pod: Manifest) =>
    [...(pod.spec?.containers[0].command ?? []), ...(pod.spec?.containers[0].args ?? [])].join(" ");

  test("the chart carries the annotations the OpenShift console catalog reads", () => {
    const chart = parse(readFileSync(join(CHART_DIR, "Chart.yaml"), "utf8")) as {
      annotations: Record<string, string>;
    };
    expect(chart.annotations["charts.openshift.io/name"]).toBe("LibreDB Studio");
    expect(chart.annotations["charts.openshift.io/provider"]).toBe("LibreDB");
    expect(chart.annotations["charts.openshift.io/providerType"]).toBe("community");
    expect(chart.annotations["charts.openshift.io/supportURL"]).toBe(
      "https://github.com/libredb/libredb-studio/issues",
    );
  });

  test("one helm test hook pod checks the health route through the Service", () => {
    const rendered = docs([]);
    const pod = hookPod(rendered);
    expect(pod.metadata.name).toBe(HOOK_NAME);
    expect(pod.metadata.annotations?.["helm.sh/hook"]).toBe("test");
    expect(pod.metadata.annotations?.["helm.sh/hook-delete-policy"]).toBe("before-hook-creation,hook-succeeded");
    const deploymentImage = deploymentPod(rendered).containers[0].image;
    expect(pod.spec?.containers[0].image).toBe(deploymentImage);
    expect(pod.spec?.containers[0].command?.[0]).toBe("node");
    expect(commandLine(pod)).toContain("http://release-under-test-libredb-studio:80/api/db/health");
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });

  test("the hook pod follows service.port", () => {
    const pod = hookPod(docs(["--set", "service.port=8080"]));
    expect(commandLine(pod)).toContain("http://release-under-test-libredb-studio:8080/api/db/health");
  });

  test("the hook pod URL carries config.basePath", () => {
    const pod = hookPod(docs(["--set", "config.basePath=/studio"]));
    expect(commandLine(pod)).toContain("http://release-under-test-libredb-studio:80/studio/api/db/health");
  });

  test("neither the Service nor the NetworkPolicy selects the hook pod", () => {
    const rendered = docs(["--set", "networkPolicy.enabled=true"]);
    const labels = hookPod(rendered).metadata.labels ?? {};
    const service = rendered.find((doc) => doc.kind === "Service");
    const policy = rendered.find((doc) => doc.kind === "NetworkPolicy") as unknown as {
      spec: { podSelector: { matchLabels: Record<string, string> } };
    };
    const selects = (selector: Record<string, string>) =>
      Object.entries(selector).every(([key, value]) => labels[key] === value);
    expect(selects(service?.spec?.selector ?? {})).toBe(false);
    expect(selects(policy.spec.podSelector.matchLabels)).toBe(false);
    expect(labels["app.kubernetes.io/name"]).toBe("libredb-studio-test");
    expect(labels["app.kubernetes.io/instance"]).toBe("release-under-test");
  });

  test("the hook pod runs under the adapted security context on OpenShift", () => {
    const rendered = docs(OPENSHIFT_API);
    const pod = hookPod(rendered);
    expect(pod.spec?.securityContext?.runAsUser).toBeUndefined();
    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.spec?.securityContext).toEqual(deploymentPod(rendered).securityContext);
    expect(pod.spec?.containers[0].securityContext).toEqual(deploymentPod(rendered).containers[0].securityContext);
  });

  test("the hook pod runs as the Deployment's service account", () => {
    for (const args of [[], ["--set", "serviceAccount.name=studio-sa"], ["--set", "serviceAccount.create=false"]]) {
      const rendered = docs(args);
      const deployment = rendered.find((doc) => doc.kind === "Deployment")?.spec?.template?.spec;
      expect(deployment?.serviceAccountName).toBeDefined();
      expect(hookPod(rendered).spec?.serviceAccountName).toBe(deployment?.serviceAccountName);
      expect(hookPod(rendered).spec?.automountServiceAccountToken).toBe(false);
    }
  });

  test("the hook pod's name label stays a valid label value under a long nameOverride", () => {
    const longName = "a".repeat(60);
    const rendered = docs(["--set", `nameOverride=${longName}`]);
    const label = hookPod(rendered).metadata.labels?.["app.kubernetes.io/name"] ?? "";
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("-test")).toBe(true);
    const service = rendered.find((doc) => doc.kind === "Service");
    expect(service?.spec?.selector?.["app.kubernetes.io/name"]).toBe(longName);
    expect(label).not.toBe(longName);
  });

  test("--skip-tests omits the hook pod", () => {
    expect(hookPods(docs(["--skip-tests"]))).toHaveLength(0);
  });

  test("the hook pod takes the chart's imagePullSecrets, nodeSelector, tolerations and resources", () => {
    for (const args of [
      [],
      [
        "--set",
        "imagePullSecrets[0].name=regcred",
        "--set",
        "nodeSelector.zone=a",
        "--set",
        "tolerations[0].key=k",
        "--set",
        "tolerations[0].operator=Exists",
        "--set",
        "resources.requests.cpu=10m",
      ],
    ]) {
      const rendered = docs(args);
      const pod = hookPod(rendered).spec;
      const deployment = deploymentPod(rendered);
      expect(pod?.imagePullSecrets).toEqual(deployment.imagePullSecrets);
      expect(pod?.nodeSelector).toEqual(deployment.nodeSelector);
      expect(pod?.tolerations).toEqual(deployment.tolerations);
      expect(pod?.containers[0].resources).toEqual(deployment.containers[0].resources);
    }
    const pod = hookPod(docs(["--set", "imagePullSecrets[0].name=regcred"])).spec;
    expect(pod?.imagePullSecrets).toEqual([{ name: "regcred" }]);
  });
});
