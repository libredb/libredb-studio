// @requires helm
/**
 * The values the operator sets on every LibreDBStudio win over the resource, and reach the chart
 * as the chart expects them.
 *
 * The operator manages only its own namespace: its controller watches only the namespace its pod
 * runs in (WATCH_NAMESPACE, set from the downward API field metadata.namespace in
 * operator/config/manager/manager.yaml), so the only LibreDBStudio it reconciles is the cluster's
 * Studio there. The chart values that decide where objects may go are still not the resource's to
 * choose: operator/watches.yaml sets them as overrideValues. operator.managed turns on the chart's
 * O14 guard, operator.clusterStudioNamespace is the operator's own namespace ($WATCH_NAMESPACE),
 * the one namespace whose resource may render cross-namespace and cluster-scoped objects, and the
 * PostgreSQL values keep every object of the bundled subchart in the resource's own namespace.
 * Any other value of the namespace fails closed: unset or another namespace, the O14 guard refuses
 * the render, and a list fails the --set-string parse before the chart is read.
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
 * after the values file. Since every override arrives as a string, every pinned key must accept a
 * string in values.schema.json, or the reconcile fails on the schema.
 *
 * The console plugin's server receives every console user's token, so its namespace and image are
 * the operator's, never the resource's: OPERATOR_NAMESPACE (the downward API's metadata.namespace)
 * and RELATED_IMAGE_PLUGIN, both from the controller's environment.
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
const MANAGER = join(ROOT, "operator/config/manager/manager.yaml");
const BUNDLE_CSV = join(ROOT, "operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml");
/** The Subscription variable the first draft of this file read; nothing may read it now. */
const DROPPED_VARIABLE = "LIBREDB_CLUSTER_STUDIO_NAMESPACE";
const RELEASE_NAMESPACE = "release-under-test";
const OPERATOR_NAMESPACE = "openshift-operators";
const PLUGIN_SERVER = "libredb-studio-console-plugin";
/** The plugin image the chart pins, which the operator's RELATED_IMAGE_PLUGIN carries too (operator-openshift-csv.test.ts). */
const PLUGIN_IMAGE = (
  parse(readFileSync(join(CHART_DIR, "values.yaml"), "utf8")) as { openshift: { consolePlugin: { image: string } } }
).openshift.consolePlugin.image;

/** The controller's environment for the cluster Studio in RELEASE_NAMESPACE. */
const OPERATOR_ENV: Record<string, string> = {
  WATCH_NAMESPACE: RELEASE_NAMESPACE,
  OPERATOR_NAMESPACE,
  RELATED_IMAGE_PLUGIN: PLUGIN_IMAGE,
};

const EXPECTED_OVERRIDES = {
  "operator.managed": "true",
  "operator.clusterStudioNamespace": "$WATCH_NAMESPACE",
  "postgresql.namespaceOverride": "",
  "postgresql.extraDeploy": "{}",
  "postgresql.serviceAccount.name": "",
  "postgresql.metrics.serviceMonitor.namespace": "",
  "postgresql.metrics.prometheusRule.namespace": "",
  "openshift.consolePlugin.namespace": "$OPERATOR_NAMESPACE",
  "openshift.consolePlugin.image": "$RELATED_IMAGE_PLUGIN",
};

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

interface PodTemplate {
  spec: { template: { spec: { containers: Array<{ name: string; env?: EnvVar[] }> } } };
}

/** The manager container's environment in the kustomize source and in the generated bundle. */
function managerEnv(): Record<string, EnvVar[] | undefined> {
  const deployment = parseAllDocuments(readFileSync(MANAGER, "utf8"))
    .map((doc) => doc.toJSON() as ({ kind: string } & PodTemplate) | null)
    .find((doc) => doc?.kind === "Deployment");
  const csv = parse(readFileSync(BUNDLE_CSV, "utf8")) as {
    spec: { install: { spec: { deployments: PodTemplate[] } } };
  };
  const envOf = (template: PodTemplate | undefined) =>
    template?.spec.template.spec.containers.find((container) => container.name === "manager")?.env;
  return { source: envOf(deployment ?? undefined), bundle: envOf(csv.spec.install.spec.deployments[0]) };
}

/** Every $NAME or ${NAME} the overrides expand. */
function expandedNames(): string[] {
  return [
    ...new Set(
      Object.values(overrideValues()).flatMap((value) =>
        [...String(value).matchAll(/\$\{(\w+)\}|\$(\w+)/g)].map((match) => match[1] ?? match[2]),
      ),
    ),
  ];
}

interface Watch {
  group: string;
  version: string;
  kind: string;
  chart: string;
  overrideValues?: Record<string, unknown>;
}

/**
 * A LibreDBStudio spec that asks for the opposite of every pinned value: off the operator's guard,
 * another cluster Studio namespace, the bundled PostgreSQL placed and named elsewhere, and the console
 * plugin's server in the resource's own namespace with an image of its choosing.
 */
const RESOURCE_SPEC = {
  global: { compatibility: { openshift: { apis: "force" } } },
  authProvider: "openshift",
  image: { tag: "1.2.0" },
  openshiftRoute: { enabled: true, host: "studio.apps.example.test" },
  openshift: {
    consoleLink: { enabled: true },
    consolePlugin: { enabled: true, namespace: RELEASE_NAMESPACE, image: "attacker.example/plugin:1" },
  },
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

function renderAsOperator(env: Record<string, string>, file = specFile) {
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
      file,
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

/** The env without one variable, as the controller runs when that variable is unset. */
function without(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(OPERATOR_ENV).filter(([key]) => key !== name));
}

interface SchemaNode {
  type?: string | string[];
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
}

/**
 * Whether the chart's schema lets a string stand at this dotted key: the type string at the key itself,
 * directly or in one anyOf branch, or a key under an object the schema leaves open (no
 * additionalProperties: false), such as the bundled subchart's postgresql.*, where the chart checks nothing.
 */
function schemaAcceptsString(schema: SchemaNode, key: string): boolean {
  let node: SchemaNode | undefined = schema;
  for (const part of key.split(".")) {
    const child: SchemaNode | undefined = node.properties?.[part];
    if (child) {
      node = child;
      continue;
    }
    if (node.additionalProperties === false) return false;
    return true;
  }
  const admits = (candidate: SchemaNode): boolean =>
    candidate.type === undefined ? (candidate.anyOf ?? []).some(admits) : [candidate.type].flat().includes("string");
  return admits(node);
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

  test("expands only WATCH_NAMESPACE and the console plugin's two variables", () => {
    expect(expandedNames()).toEqual(["WATCH_NAMESPACE", "OPERATOR_NAMESPACE", "RELATED_IMAGE_PLUGIN"]);
  });

  test.each(["source", "bundle"])(
    "finds every variable it expands on the manager container of the %s Deployment",
    (name) => {
      const env = managerEnv()[name] ?? [];
      for (const variable of expandedNames()) {
        expect({ variable, set: env.some((entry) => entry.name === variable) }).toEqual({ variable, set: true });
      }
    },
  );

  test.each(["source", "bundle"])(
    "gets WATCH_NAMESPACE in the %s Deployment from the pod's own namespace, one name and never empty",
    (name) => {
      expect(managerEnv()[name]?.filter((entry) => entry.name === "WATCH_NAMESPACE")).toEqual([
        { name: "WATCH_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
      ]);
    },
  );

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
  test("renders, with the operator's namespace the resource's own", () => {
    const run = renderAsOperator(OPERATOR_ENV);
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  });

  test("renders the O14-gated objects for that namespace: the discovery Role and the ConsoleLink", () => {
    const docs = renderedDocs(OPERATOR_ENV);
    expect(docs.some((doc) => doc.kind === "Role" && metadataOf(doc).namespace === "team-a")).toBe(true);
    expect(docs.some((doc) => doc.kind === "ConsoleLink")).toBe(true);
  });

  test("keeps every object of the bundled PostgreSQL in the resource's namespace", () => {
    const docs = renderedDocs(OPERATOR_ENV);
    // team-a holds the discovery Role and RoleBinding, which O14 allows this resource, and the operator's
    // namespace exactly the four objects of the console plugin's server.
    const plugin = docs
      .filter((doc) => metadataOf(doc).namespace === OPERATOR_NAMESPACE)
      .map((doc) => `${doc.kind}/${metadataOf(doc).name}`);
    expect(plugin.sort()).toEqual(
      ["Deployment", "NetworkPolicy", "Service", "ServiceAccount"].map((kind) => `${kind}/${PLUGIN_SERVER}`),
    );
    const placed = docs
      .map((doc) => metadataOf(doc).namespace)
      .filter((namespace) => namespace != null && namespace !== "team-a" && namespace !== OPERATOR_NAMESPACE);
    expect(new Set(placed)).toEqual(new Set([RELEASE_NAMESPACE]));
    expect(docs.filter((doc) => doc.kind === "ServiceMonitor" || doc.kind === "PrometheusRule")).toHaveLength(2);
  });

  test("renders no extraDeploy manifest and names no account the resource chose", () => {
    const docs = renderedDocs(OPERATOR_ENV);
    expect(docs.map((doc) => metadataOf(doc).name)).not.toContain("from-extra-deploy");
    const statefulSet = docs.find((doc) => doc.kind === "StatefulSet");
    const account = (statefulSet?.spec as { template: { spec: { serviceAccountName?: string } } } | undefined)?.template
      .spec.serviceAccountName;
    expect(account).toBeDefined();
    expect(account).not.toBe("other-account");
  });

  test.each([
    ["is unset", without("WATCH_NAMESPACE")],
    ["names another namespace", { ...OPERATOR_ENV, WATCH_NAMESPACE: "other-namespace" }],
  ])("fails closed, naming operator.clusterStudioNamespace, when WATCH_NAMESPACE %s", (_case, env) => {
    const run = renderAsOperator(env);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("operator.clusterStudioNamespace");
    expect(run.stderr.toString()).not.toContain("want boolean");
  });

  test("fails closed, before the chart is read, when WATCH_NAMESPACE lists two namespaces", () => {
    const run = renderAsOperator({ ...OPERATOR_ENV, WATCH_NAMESPACE: `${RELEASE_NAMESPACE},team-a` });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("has no value");
    expect(run.stdout.toString()).toBe("");
  });
});

describe("the dropped Subscription variable", () => {
  test("is named by no file of the operator, the chart or the docs", () => {
    const listed = Bun.spawnSync(
      [
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "operator",
        "charts/libredb-studio",
        "docs",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout
      .toString()
      .split("\0")
      .filter((file) => file !== "" && !file.startsWith("docs/superpowers/"));
    expect(files.length).toBeGreaterThan(0);
    const naming = files.filter((file) => readFileSync(join(ROOT, file)).toString("latin1").includes(DROPPED_VARIABLE));
    expect(naming).toEqual([]);
  });
});

describe("the console plugin under the operator", () => {
  test("runs in the operator's namespace with the pinned image, whatever the resource asks", () => {
    const run = renderAsOperator(OPERATOR_ENV);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).not.toContain("attacker.example");
    const docs = renderedDocs(OPERATOR_ENV);
    const deployment = docs.find((doc) => doc.kind === "Deployment" && metadataOf(doc).name === PLUGIN_SERVER);
    if (!deployment) throw new Error(`no Deployment ${PLUGIN_SERVER} in the render`);
    expect(metadataOf(deployment).namespace).toBe(OPERATOR_NAMESPACE);
    const containers = (deployment.spec as { template: { spec: { containers: Array<{ image: string }> } } }).template
      .spec.containers;
    expect(containers.map((container) => container.image)).toEqual([PLUGIN_IMAGE]);
    const plugin = docs.find((doc) => doc.kind === "ConsolePlugin");
    if (!plugin) throw new Error("no ConsolePlugin in the render");
    expect((plugin.spec as { backend: { service: { namespace: string } } }).backend.service.namespace).toBe(
      OPERATOR_NAMESPACE,
    );
  });

  test("fails closed, naming openshift.consolePlugin.namespace and OPERATOR_NAMESPACE, when that is unset", () => {
    const run = renderAsOperator(without("OPERATOR_NAMESPACE"));
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("openshift.consolePlugin.namespace is empty");
    expect(run.stderr.toString()).toContain("OPERATOR_NAMESPACE");
  });

  test("fails closed, naming openshift.consolePlugin.image and RELATED_IMAGE_PLUGIN, when that is unset", () => {
    const run = renderAsOperator(without("RELATED_IMAGE_PLUGIN"));
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("openshift.consolePlugin.image is empty");
    expect(run.stderr.toString()).toContain("RELATED_IMAGE_PLUGIN");
  });

  test("refuses, on the schema, a resource that asks for more replicas than the chart allows", () => {
    const file = join(scratch, "replicas.yaml");
    const spec = structuredClone(RESOURCE_SPEC);
    Object.assign(spec.openshift.consolePlugin, { replicas: 6 });
    writeFileSync(file, stringify(spec));
    const run = renderAsOperator(OPERATOR_ENV, file);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("/openshift/consolePlugin/replicas");
  });
});

describe("every pinned key accepts a string in values.schema.json", () => {
  const schema = JSON.parse(readFileSync(join(CHART_DIR, "values.schema.json"), "utf8")) as SchemaNode;
  /** The string each override reaches the chart as, in the operator render above. */
  const expanded = Object.fromEntries(
    Object.entries(overrideValues()).map(([key, value]) => [key, expandEnv(String(value), OPERATOR_ENV)]),
  );

  test("the expansion names the values the render above uses", () => {
    expect(expanded["openshift.consolePlugin.namespace"]).toBe(OPERATOR_NAMESPACE);
    expect(expanded["openshift.consolePlugin.image"]).toBe(PLUGIN_IMAGE);
    expect(expanded["operator.clusterStudioNamespace"]).toBe(RELEASE_NAMESPACE);
  });

  test.each(Object.keys(EXPECTED_OVERRIDES))("%s admits the type string", (key) => {
    expect(schemaAcceptsString(schema, key)).toBe(true);
  });

  test.each(Object.keys(EXPECTED_OVERRIDES))("%s, as the string the operator delivers, passes the schema", (key) => {
    const run = Bun.spawnSync(
      [
        "helm",
        "template",
        "studio",
        CHART_DIR,
        "--namespace",
        RELEASE_NAMESPACE,
        "--set-string",
        `${key}=${expanded[key]}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect({ key, stderr: run.stderr.toString() }).not.toEqual({
      key,
      stderr: expect.stringContaining("don't meet the specifications of the schema"),
    });
    expect({ key, exitCode: run.exitCode }).toEqual({ key, exitCode: 0 });
  });

  test("the walk refuses a key under a closed object, so the cases above check something", () => {
    expect(schemaAcceptsString(schema, "openshift.consolePlugin.replicas")).toBe(false);
    expect(schemaAcceptsString(schema, "openshift.consolePlugin.unknown")).toBe(false);
    expect(schemaAcceptsString(schema, "postgresql.anything.at.all")).toBe(true);
  });
});
