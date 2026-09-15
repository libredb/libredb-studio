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
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
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
      throw new Error(
        `could not vendor the postgresql subchart dependency: ${repoAdd.stderr.toString()} ${depBuild.stderr.toString()}`,
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
      throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
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
