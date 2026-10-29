// @requires helm
/**
 * The values the operator sets on every LibreDBStudio win over the resource, and reach the chart
 * as the chart expects them.
 *
 * Any namespace editor may create a LibreDBStudio, and the cluster-wide operator reconciles it.
 * So the chart values that decide where objects may go are not the resource's to choose:
 * operator/watches.yaml sets them as overrideValues. operator.managed turns on the chart's O14
 * guard, operator.clusterStudioNamespace names the one namespace whose resource may render
 * cross-namespace and cluster-scoped objects (LIBREDB_CLUSTER_STUDIO_NAMESPACE, which a cluster
 * admin sets in the Subscription; unset, no namespace may), and the PostgreSQL values keep every
 * object of the bundled subchart in the resource's own namespace.
 *
 * How helm-operator applies them, read from operator-sdk v1.42.3, the base image of
 * operator/Dockerfile: internal/helm/watches/watches.go expands each value with os.ExpandEnv, and
 * internal/helm/release/manager_factory.go parses `key=value` with strvals.ParseIntoString, the
 * parser behind `helm --set-string`, then merges the result over the resource's spec. So an
 * override always wins, and always arrives as a string: "true" is the string "true", never a
 * boolean, and `{}` is a list holding one empty string, the nearest a string parser comes to an
 * empty list. A boolean value cannot be pinned this way at all, since the string "false" is
 * truthy in a template.
 *
 * The render below does the same with the helm CLI: the resource's spec as a values file that asks
 * for the opposite of every pinned value, then each override as --set-string, which Helm applies
 * after the values file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/libredb-studio");
const WATCHES = join(ROOT, "operator/watches.yaml");
const DOCKERFILE = join(ROOT, "operator/Dockerfile");
const RELEASE_NAMESPACE = "release-under-test";

const EXPECTED_OVERRIDES = {
  "operator.managed": "true",
  "operator.clusterStudioNamespace": "$LIBREDB_CLUSTER_STUDIO_NAMESPACE",
  "postgresql.namespaceOverride": "",
  "postgresql.extraDeploy": "{}",
  "postgresql.serviceAccount.name": "",
  "postgresql.metrics.serviceMonitor.namespace": "",
  "postgresql.metrics.prometheusRule.namespace": "",
};

interface Watch {
  group: string;
  version: string;
  kind: string;
  chart: string;
  overrideValues?: Record<string, unknown>;
}

/**
 * A LibreDBStudio spec that asks for the opposite of every pinned value: off the operator's guard,
 * another cluster Studio namespace, and the bundled PostgreSQL placed and named elsewhere.
 */
const RESOURCE_SPEC = {
  global: { compatibility: { openshift: { apis: "force" } } },
  authProvider: "openshift",
  image: { tag: "1.2.0" },
  openshiftRoute: { enabled: true, host: "studio.apps.example.test" },
  openshift: { consoleLink: { enabled: true } },
  discovery: { kubernetes: { enabled: true, namespaces: ["team-a"], kinds: ["cnpg"] } },
  operator: { managed: false, clusterStudioNamespace: "other-namespace" },
  postgresql: {
    enabled: true,
    namespaceOverride: "other-namespace",
    extraDeploy: [{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "from-extra-deploy" } }],
    serviceAccount: { create: false, name: "other-account" },
    metrics: {
      enabled: true,
      serviceMonitor: { enabled: true, namespace: "monitor-namespace" },
      prometheusRule: { enabled: true, namespace: "rule-namespace" },
    },
  },
};

const scratch = mkdtempSync(join(tmpdir(), "operator-watches-"));
const specFile = join(scratch, "spec.yaml");
writeFileSync(specFile, stringify(RESOURCE_SPEC));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function watches(): Watch[] {
  return parse(readFileSync(WATCHES, "utf8")) as Watch[];
}

function overrideValues(): Record<string, unknown> {
  const studio = watches().find((watch) => watch.kind === "LibreDBStudio");
  return studio?.overrideValues ?? {};
}

/** os.ExpandEnv: $NAME and ${NAME}, an unset name expanding to nothing. */
function expandEnv(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced: string | undefined, bare: string | undefined) => {
    return env[braced ?? bare ?? ""] ?? "";
  });
}

/** Each override the way helm-operator applies it: expanded, then parsed as --set-string. */
function overrideArgs(env: Record<string, string>): string[] {
  return Object.entries(overrideValues()).flatMap(([key, value]) => [
    "--set-string",
    `${key}=${expandEnv(String(value), env)}`,
  ]);
}

function renderAsOperator(env: Record<string, string>) {
  return Bun.spawnSync(
    [
      "helm",
      "template",
      "studio",
      CHART_DIR,
      "--namespace",
      RELEASE_NAMESPACE,
      "--api-versions",
      "monitoring.coreos.com/v1",
      "-f",
      specFile,
      ...overrideArgs(env),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}

function renderedDocs(env: Record<string, string>): Array<Record<string, unknown>> {
  const run = renderAsOperator(env);
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr.toString()}`);
  }
  return parseAllDocuments(run.stdout.toString())
    .map((doc) => doc.toJSON() as Record<string, unknown> | null)
    .filter((doc): doc is Record<string, unknown> => doc != null);
}

function metadataOf(doc: Record<string, unknown>): { name?: string; namespace?: string } {
  return (doc.metadata as { name?: string; namespace?: string } | undefined) ?? {};
}

describe("operator/watches.yaml", () => {
  test("is read by the helm-operator release whose override parsing this file describes", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).toContain("FROM quay.io/operator-framework/helm-operator:v1.42.3\n");
  });

  test("watches LibreDBStudio with the embedded chart", () => {
    expect(watches().map(({ group, version, kind, chart }) => ({ group, version, kind, chart }))).toEqual([
      { group: "studio.libredb.org", version: "v1alpha1", kind: "LibreDBStudio", chart: "helm-charts/libredb-studio" },
    ]);
  });

  test("pins exactly the reviewed values", () => {
    expect(overrideValues()).toEqual(EXPECTED_OVERRIDES);
  });

  test("writes every value as a string with no template action, so the parse above is the whole story", () => {
    for (const [key, value] of Object.entries(overrideValues())) {
      expect({ key, type: typeof value, template: String(value).includes("{{") }).toEqual({
        key,
        type: "string",
        template: false,
      });
    }
  });
});

describe("the chart rendered as the operator renders a resource that asks for the opposite", () => {
  test("renders, with the cluster Studio namespace set to the resource's own", () => {
    const run = renderAsOperator({ LIBREDB_CLUSTER_STUDIO_NAMESPACE: RELEASE_NAMESPACE });
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  });

  test("renders the O14-gated objects for that namespace: the discovery Role and the ConsoleLink", () => {
    const docs = renderedDocs({ LIBREDB_CLUSTER_STUDIO_NAMESPACE: RELEASE_NAMESPACE });
    expect(docs.some((doc) => doc.kind === "Role" && metadataOf(doc).namespace === "team-a")).toBe(true);
    expect(docs.some((doc) => doc.kind === "ConsoleLink")).toBe(true);
  });

  test("keeps every object of the bundled PostgreSQL in the resource's namespace", () => {
    const docs = renderedDocs({ LIBREDB_CLUSTER_STUDIO_NAMESPACE: RELEASE_NAMESPACE });
    // team-a holds the discovery Role and RoleBinding, which O14 allows this resource.
    const placed = docs
      .map((doc) => metadataOf(doc).namespace)
      .filter((namespace) => namespace != null && namespace !== "team-a");
    expect(new Set(placed)).toEqual(new Set([RELEASE_NAMESPACE]));
    expect(docs.filter((doc) => doc.kind === "ServiceMonitor" || doc.kind === "PrometheusRule")).toHaveLength(2);
  });

  test("renders no extraDeploy manifest and names no account the resource chose", () => {
    const docs = renderedDocs({ LIBREDB_CLUSTER_STUDIO_NAMESPACE: RELEASE_NAMESPACE });
    expect(docs.map((doc) => metadataOf(doc).name)).not.toContain("from-extra-deploy");
    const statefulSet = docs.find((doc) => doc.kind === "StatefulSet");
    const account = (statefulSet?.spec as { template: { spec: { serviceAccountName?: string } } } | undefined)?.template
      .spec.serviceAccountName;
    expect(account).toBeDefined();
    expect(account).not.toBe("other-account");
  });

  test.each([
    ["is unset", {}],
    ["names another namespace", { LIBREDB_CLUSTER_STUDIO_NAMESPACE: "other-namespace" }],
  ])("fails closed, naming operator.clusterStudioNamespace, when LIBREDB_CLUSTER_STUDIO_NAMESPACE %s", (_case, env) => {
    const run = renderAsOperator(env as Record<string, string>);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("operator.clusterStudioNamespace");
    expect(run.stderr.toString()).not.toContain("want boolean");
  });
});
