// @requires helm
/**
 * The OpenShift console plugin in Studio's chart (openshift.consolePlugin).
 *
 * The plugin is a static bundle the console loads into every console session, served by an nginx
 * server that receives every console user's bearer token on each asset fetch. So whoever can change
 * that server's Deployment runs code in every console session and receives every console user's
 * token, and the chart refuses every place a person who is not a cluster admin could do that: on the Helm
 * path Studio's own namespace, on both paths a discovered namespace and a project a user requested. With
 * the plugin on, the release's own namespace falls under the cluster Studio namespace rule, so it may not
 * be a requested project either, and Studio's name may not be the server's. Under
 * the operator the server runs only in the operator's own namespace, the cluster Studio namespace that
 * only cluster admins write, and any other plugin namespace is refused. The server
 * runs an image pinned by digest, as its own ServiceAccount with no token, and the ConsolePlugin
 * declares no proxy and no content security policy. The chart renders no Job, ClusterRole or
 * ClusterRoleBinding for the plugin: a cluster admin turns it on in the console.
 *
 * Every case runs the real `helm template` against the chart, never a reimplementation of the templating.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "studio";
const NAMESPACE = "release-under-test";
const PLUGIN_NAMESPACE = "libredb-console-plugin";
const SERVER = "libredb-studio-console-plugin";
const ZERO_DIGEST = "0".repeat(64);

/**
 * The plugin image the chart ships: the plugin's 0.1.0 release, pinned by the index digest its release
 * notes name (both platforms).
 */
const PLUGIN_IMAGE =
  "ghcr.io/libredb/libredb-studio-openshift-plugin:0.1.0@sha256:39698233d019f4e69fe106e634af789291011d59d27d5858a7e4d0b41283d86e";

interface Manifest {
  apiVersion: string;
  kind: string;
  automountServiceAccountToken?: boolean;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  rules?: Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }>;
  spec?: Record<string, unknown>;
}

/** The output of every render this file makes, for the file-wide checks at its end. */
const RENDERED: string[] = [];

function template(args: string[], chart = CHART_DIR): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, chart, "--namespace", NAMESPACE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  if (result.exitCode === 0) RENDERED.push(result.stdout);
  return result;
}

/** Each document of a render with the template it came from, from helm's "# Source:" line. */
function sourced(stdout: string): Array<{ source: string; doc: Manifest }> {
  return stdout
    .split(/^---$/m)
    .map((chunk) => ({ source: /^# Source: (.+)$/m.exec(chunk)?.[1] ?? "", doc: parse(chunk) as Manifest | null }))
    .filter((entry): entry is { source: string; doc: Manifest } => entry.doc != null);
}

function render(args: string[]): Manifest[] {
  const run = template(args);
  if (run.exitCode !== 0) throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as Manifest)
    .filter(Boolean);
}

function refused(args: string[], ...needles: string[]): void {
  refusedIn(CHART_DIR, args, ...needles);
}

function refusedIn(chart: string, args: string[], ...needles: string[]): void {
  const run = template(args, chart);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
}

function one(docs: Manifest[], kind: string, name: string): Manifest {
  const found = docs.filter((doc) => doc.kind === kind && doc.metadata.name === name);
  expect(found).toHaveLength(1);
  return found[0];
}

interface Container {
  name: string;
  image?: string;
  imagePullPolicy?: string;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  envFrom?: unknown;
  ports?: Array<{ name?: string; containerPort: number; protocol?: string }>;
  readinessProbe?: unknown;
  resources?: unknown;
  securityContext?: Record<string, unknown>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
}

interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  enableServiceLinks?: boolean;
  securityContext?: Record<string, unknown>;
  containers: Container[];
  volumes?: Array<{ name: string; secret?: { secretName: string; defaultMode?: number }; emptyDir?: unknown }>;
}

interface DeploymentSpec {
  replicas: number;
  selector: { matchLabels: Record<string, string> };
  template: { metadata: { labels: Record<string, string> }; spec: PodSpec };
}

function deploymentSpec(docs: Manifest[]): DeploymentSpec {
  return one(docs, "Deployment", SERVER).spec as unknown as DeploymentSpec;
}

function set(...pairs: string[]): string[] {
  return pairs.flatMap((pair) => ["--set", pair]);
}

/** The PLUGIN_ON pairs as a map, so a case can change one value and keep the rest. */
const PLUGIN_ON_PAIRS: Record<string, string> = {
  "global.compatibility.openshift.apis": "force",
  authProvider: "openshift",
  "image.tag": "1.2.0",
  "openshiftRoute.enabled": "true",
  "openshiftRoute.host": "studio.apps.example.test",
  "openshift.consoleLink.enabled": "true",
  "discovery.kubernetes.enabled": "true",
  "discovery.kubernetes.namespaces": "{team-a}",
  "openshift.consolePlugin.enabled": "true",
  "openshift.consolePlugin.namespace": PLUGIN_NAMESPACE,
};

/** PLUGIN_ON with some values changed, and a value set to null left out. */
function pluginOn(changes: Record<string, string | null> = {}): string[] {
  const merged: Record<string, string | null> = { ...PLUGIN_ON_PAIRS, ...changes };
  return set(
    ...Object.entries(merged)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([key, value]) => `${key}=${value}`),
  );
}

const PLUGIN_ON = pluginOn();

/** The values the operator pins on its own resource: the operator path, in the release's namespace. */
const OPERATOR = set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`);

/** PLUGIN_ON as the operator renders it: the plugin server in the operator's own namespace, the release's. */
function operatorOn(changes: Record<string, string | null> = {}): string[] {
  return [...pluginOn({ "openshift.consolePlugin.namespace": NAMESPACE, ...changes }), ...OPERATOR];
}

const values = parse(readFileSync(join(CHART_DIR, "values.yaml"), "utf8"));
const helpers = readFileSync(join(CHART_DIR, "templates/_helpers.tpl"), "utf8");

describe("openshift.consolePlugin values", () => {
  test("default off, with no namespace, the pinned image and the template's server size", () => {
    expect(values.openshift.consolePlugin).toEqual({
      enabled: false,
      namespace: "",
      image: PLUGIN_IMAGE,
      imagePullPolicy: "IfNotPresent",
      replicas: 2,
      resources: { requests: { cpu: "10m", memory: "50Mi" } },
    });
  });

  test("Chart.yaml lists the same plugin image for Artifact Hub, for both platforms", () => {
    const chart = parse(readFileSync(join(CHART_DIR, "Chart.yaml"), "utf8")) as { annotations: Record<string, string> };
    const images = parse(chart.annotations["artifacthub.io/images"]) as Array<{
      name: string;
      image: string;
      platforms: string[];
    }>;
    expect(images.find((entry) => entry.name === "libredb-studio-openshift-plugin")).toEqual({
      name: "libredb-studio-openshift-plugin",
      image: values.openshift.consolePlugin.image,
      platforms: ["linux/amd64", "linux/arm64"],
    });
  });

  test("pins a released digest, never the provisional all-zero one", () => {
    // Keeps a placeholder digest from ever shipping in values.yaml (S4).
    expect(values.openshift.consolePlugin.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(values.openshift.consolePlugin.image.endsWith(ZERO_DIGEST)).toBe(false);
  });

  test.each([
    [[], "no console API"],
    [["--api-versions", "console.openshift.io/v1"], "the console API served"],
  ])("render no ConsolePlugin, no plugin object and no Job by default (%#, %s)", (args) => {
    const docs = render(args);
    expect(docs.filter((doc) => doc.kind === "ConsolePlugin")).toEqual([]);
    expect(docs.filter((doc) => doc.metadata.name === SERVER)).toEqual([]);
    expect(docs.filter((doc) => doc.kind === "Job")).toEqual([]);
  });

  test.each([
    ["openshift.consolePlugin.namespace=Bad_NS", "/openshift/consolePlugin/namespace"],
    ["openshift.consolePlugin.unknown=true", "consolePlugin"],
    ["openshift.consolePlugin.enableInConsole=true", "enableInConsole"],
    ["openshift.consolePlugin.patcherImage=registry.example/patcher@sha256:" + "a".repeat(64), "patcherImage"],
    [
      "openshift.consolePlugin.image=ghcr.io/libredb/libredb-studio-openshift-plugin:0.1.0",
      "/openshift/consolePlugin/image",
    ],
    ["openshift.consolePlugin.replicas=6", "/openshift/consolePlugin/replicas"],
    ["openshift.consolePlugin.replicas=0", "/openshift/consolePlugin/replicas"],
    ["openshift.consolePlugin.imagePullPolicy=Sometimes", "/openshift/consolePlugin/imagePullPolicy"],
    ["openshift.consolePlugin.resources.requests.nvidia\\.com/gpu=1", "nvidia.com/gpu"],
    ["openshift.consolePlugin.resources.claims=x", "claims"],
  ])("the schema refuses %s", (pair, needle) => {
    refused(set(pair), needle);
  });

  test("the schema accepts an empty namespace, an empty image and a digest reference", () => {
    render(set("openshift.consolePlugin.namespace=", "openshift.consolePlugin.image="));
    render(set(`openshift.consolePlugin.image=registry.example/mirror/plugin@sha256:${"b".repeat(64)}`));
    render(
      set("openshift.consolePlugin.resources.limits.cpu=1", "openshift.consolePlugin.resources.limits.memory=64Mi"),
    );
  });
});

describe("the console plugin guards, each naming the value to change", () => {
  test("PLUGIN_ON renders, so every case below fails on the value it changes", () => {
    const docs = render(PLUGIN_ON);
    expect(docs.filter((doc) => doc.kind === "ConsoleLink").map((doc) => doc.metadata.name)).toEqual([
      "libredb-studio",
    ]);
  });

  test("(1) refuses a cluster that does not serve console.openshift.io/v1, naming the force switch", () => {
    refused(
      [
        ...pluginOn({ "global.compatibility.openshift.apis": null, "openshift.consoleLink.enabled": "false" }),
        "--api-versions",
        "route.openshift.io/v1",
        "--api-versions",
        "security.openshift.io/v1",
        "--api-versions",
        "config.openshift.io/v1",
      ],
      "openshift.consolePlugin.enabled is true but this cluster does not serve console.openshift.io/v1",
      "global.compatibility.openshift.apis=force",
      "the console plugin needs OpenShift 4.19 or later",
    );
  });

  test("(2) under the operator, refuses a resource outside the cluster Studio namespace", () => {
    refused(
      [
        ...pluginOn({ "openshift.consoleLink.enabled": "false", "discovery.kubernetes.enabled": "false" }),
        ...set("operator.managed=true", "operator.clusterStudioNamespace=other"),
      ],
      "openshift.consolePlugin.enabled renders a cluster-scoped ConsolePlugin and its server in another namespace",
      "operator.clusterStudioNamespace",
    );
  });

  test("(3) refuses an empty namespace", () => {
    refused(
      pluginOn({ "openshift.consolePlugin.namespace": "" }),
      "openshift.consolePlugin.namespace is empty",
      "oc create namespace",
    );
  });

  test("(3) under the operator, the empty namespace names WATCH_NAMESPACE, the operator's own namespace", () => {
    refused(
      operatorOn({ "openshift.consolePlugin.namespace": "" }),
      "openshift.consolePlugin.namespace is empty",
      "WATCH_NAMESPACE",
    );
    expect(template(operatorOn({ "openshift.consolePlugin.namespace": "" })).stderr).not.toContain(
      "OPERATOR_NAMESPACE",
    );
  });

  test("(4) on the Helm path, refuses the release's own namespace", () => {
    refused(
      pluginOn({ "openshift.consolePlugin.namespace": NAMESPACE }),
      `openshift.consolePlugin.namespace is ${NAMESPACE}, this release's own namespace`,
      "every console session",
    );
  });

  test("(4) under the operator, renders the server in the operator's own namespace, the cluster Studio's", () => {
    const run = template(operatorOn());
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const docs = render(operatorOn());
    const server = docs
      .filter((doc) => doc.metadata.name === SERVER)
      .map((doc) => `${doc.kind}/${doc.metadata.namespace}`)
      .sort();
    expect(server).toEqual(
      ["Deployment", "NetworkPolicy", "Service", "ServiceAccount"].map((kind) => `${kind}/${NAMESPACE}`),
    );
    const plugin = one(docs, "ConsolePlugin", "libredb-studio");
    expect((plugin.spec as { backend: { service: { namespace: string } } }).backend.service.namespace).toBe(NAMESPACE);
  });

  test("(4) under the operator, refuses a plugin namespace other than the operator's own", () => {
    refused(
      operatorOn({ "openshift.consolePlugin.namespace": PLUGIN_NAMESPACE }),
      `openshift.consolePlugin.namespace is ${PLUGIN_NAMESPACE}, not the operator's own namespace ${NAMESPACE}`,
      "WATCH_NAMESPACE",
    );
  });

  test("(5) under the operator, still refuses the operator's namespace when discovery lists it", () => {
    refused(
      operatorOn({ "discovery.kubernetes.namespaces": `{team-a,${NAMESPACE}}` }),
      `openshift.consolePlugin.namespace is ${NAMESPACE}, which discovery.kubernetes.namespaces lists`,
    );
  });

  test("(5) refuses a discovered namespace", () => {
    refused(
      pluginOn({ "openshift.consolePlugin.namespace": "team-a" }),
      "openshift.consolePlugin.namespace is team-a, which discovery.kubernetes.namespaces lists",
      "every console session",
    );
  });

  test("(6) cannot see a namespace under helm template, where lookup returns nothing, so PLUGIN_ON renders", () => {
    const run = template(PLUGIN_ON);
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
  });

  test("(6) on both paths, looks up the plugin namespace and the release's and refuses a project a user requested", () => {
    const guard = helpers.slice(
      helpers.indexOf('{{- define "libredb-studio.consolePluginGuards" -}}'),
      helpers.indexOf("{{- end }}\n\n", helpers.indexOf('{{- define "libredb-studio.consolePluginGuards" -}}')),
    );
    expect(guard).toContain(
      '{{- range $checked := uniq (list $namespace .Release.Namespace) }}\n{{- $object := lookup "v1" "Namespace" "" $checked }}\n',
    );
    expect(guard).not.toMatch(
      /\{\{- if not \(include "libredb-studio\.operatorManaged" \.\) \}\}\n\{\{- \$object := lookup/,
    );
    expect(guard).toContain('{{- if hasKey $annotations "openshift.io/requester" }}');
    expect(guard).toContain("oc create namespace");
    expect(guard).toContain("oc adm policy who-can update deployments.apps -n");
  });

  test("(7) refuses a release without discovery, which renders no locator", () => {
    refused(
      pluginOn({ "discovery.kubernetes.enabled": "false" }),
      "openshift.consolePlugin.enabled needs discovery.kubernetes.enabled",
      "the console plugin finds Studio only through the console link named libredb-studio",
    );
  });

  test("(7) refuses a release without the console link", () => {
    refused(
      pluginOn({ "openshift.consoleLink.enabled": "false" }),
      "openshift.consolePlugin.enabled needs openshift.consoleLink.enabled",
      "the console plugin finds Studio only through the console link named libredb-studio",
    );
  });

  test("(8) refuses an empty image, and says how an upgrade from a chart without the plugin gets it", () => {
    refused(
      pluginOn({ "openshift.consolePlugin.image": "" }),
      "openshift.consolePlugin.image is empty",
      "--reuse-values from chart 0.1.117 or earlier",
      "--reset-then-reuse-values",
    );
  });

  test("(8) under the operator, the empty image names RELATED_IMAGE_PLUGIN", () => {
    refused(
      operatorOn({ "openshift.consolePlugin.image": "" }),
      "openshift.consolePlugin.image is empty",
      "RELATED_IMAGE_PLUGIN",
    );
    expect(template(operatorOn({ "openshift.consolePlugin.image": "" })).stderr).not.toContain(
      "--reset-then-reuse-values",
    );
  });

  test.each([
    [[], "the Helm path"],
    [OPERATOR, "the operator path"],
  ])("(9) refuses a nameOverride that gives Studio the server's name and selector labels (%#, %s)", (path) => {
    const base = path.length ? operatorOn() : PLUGIN_ON;
    refused(
      [...base, ...set(`nameOverride=${SERVER}`)],
      `nameOverride makes Studio's name ${SERVER}, the console plugin server's name`,
      "selector labels",
    );
  });

  test("(9) refuses a fullnameOverride or a release name that gives Studio's objects the server's name", () => {
    refused(
      [...operatorOn(), ...set(`fullnameOverride=${SERVER}`)],
      `fullnameOverride or the release name makes Studio's objects ${SERVER}, the console plugin server's name`,
    );
    const run = Bun.spawnSync(["helm", "template", SERVER, CHART_DIR, "--namespace", NAMESPACE, ...operatorOn()], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain(
      `fullnameOverride or the release name makes Studio's objects ${SERVER}, the console plugin server's name`,
    );
  });

  test("(9) accepts any other nameOverride and both overrides without the plugin", () => {
    render([...PLUGIN_ON, ...set("nameOverride=studio-db")]);
    render([
      ...pluginOn({ "openshift.consolePlugin.enabled": "false" }),
      ...set(`nameOverride=${SERVER}`, `fullnameOverride=${SERVER}`),
    ]);
  });
});

describe("the plugin server and the ConsolePlugin", () => {
  const docs = render(PLUGIN_ON);

  test("the ConsolePlugin libredb-studio is cluster-scoped and points at the server's Service", () => {
    const plugin = one(docs, "ConsolePlugin", "libredb-studio");
    expect(plugin.apiVersion).toBe("console.openshift.io/v1");
    expect(plugin.metadata.namespace).toBeUndefined();
    expect(plugin.spec?.displayName).toBe("LibreDB Studio");
    expect(plugin.spec?.backend).toEqual({
      type: "Service",
      service: { name: SERVER, namespace: PLUGIN_NAMESPACE, port: 9443, basePath: "/" },
    });
    expect(plugin.spec?.i18n).toEqual({ loadType: "Preload" });
  });

  test("the ConsolePlugin declares no proxy and no content security policy", () => {
    const keys = Object.keys(one(docs, "ConsolePlugin", "libredb-studio").spec ?? {});
    expect(keys).not.toContain("proxy");
    expect(keys).not.toContain("contentSecurityPolicy");
    expect(keys.sort()).toEqual(["backend", "displayName", "i18n"]);
  });

  test("the ServiceAccount, Deployment and Service sit in the plugin namespace", () => {
    for (const kind of ["ServiceAccount", "Deployment", "Service"]) {
      expect({ kind, namespace: one(docs, kind, SERVER).metadata.namespace }).toEqual({
        kind,
        namespace: PLUGIN_NAMESPACE,
      });
    }
  });

  test("the ServiceAccount mounts no token", () => {
    expect(one(docs, "ServiceAccount", SERVER).automountServiceAccountToken).toBe(false);
  });

  test("the Service asks the service CA for the serving certificate and serves 9443 from the server's pods", () => {
    const service = one(docs, "Service", SERVER);
    expect(service.metadata.annotations).toEqual({
      "service.beta.openshift.io/serving-cert-secret-name": `${SERVER}-cert`,
    });
    const spec = service.spec as { selector: Record<string, string>; ports: unknown[] };
    expect(spec.ports).toEqual([{ name: "https", protocol: "TCP", port: 9443, targetPort: 9443 }]);
    expect(spec.selector).toEqual(deploymentSpec(docs).selector.matchLabels);
  });

  test("the server's selector is its own, never Studio's", () => {
    expect(deploymentSpec(docs).selector.matchLabels).toEqual({
      "app.kubernetes.io/name": SERVER,
      "app.kubernetes.io/instance": RELEASE,
    });
    expect(deploymentSpec(docs).template.metadata.labels).toMatchObject({
      "app.kubernetes.io/name": SERVER,
      "app.kubernetes.io/component": "console-plugin",
    });
  });

  test("the Deployment runs the pinned image, two replicas, as its own account with no token", () => {
    const spec = deploymentSpec(docs);
    expect(spec.replicas).toBe(2);
    expect(spec.template.spec.serviceAccountName).toBe(SERVER);
    expect(spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(spec.template.spec.containers).toHaveLength(1);
    const [container] = spec.template.spec.containers;
    expect(container.image).toBe(values.openshift.consolePlugin.image);
    expect(container.imagePullPolicy).toBe("IfNotPresent");
    expect(container.ports).toEqual([{ name: "https", containerPort: 9443, protocol: "TCP" }]);
    expect(container.resources).toEqual({ requests: { cpu: "10m", memory: "50Mi" } });
  });

  test("the container runs the image as built: no command, args, env or envFrom", () => {
    const [container] = deploymentSpec(docs).template.spec.containers;
    for (const key of ["command", "args", "env", "envFrom"]) expect(Object.keys(container)).not.toContain(key);
  });

  test("the pod gets no service links in its environment", () => {
    expect(deploymentSpec(docs).template.spec.enableServiceLinks).toBe(false);
  });

  test("the pod is ready once it serves the plugin manifest over HTTPS on 9443", () => {
    expect(deploymentSpec(docs).template.spec.containers[0].readinessProbe).toEqual({
      httpGet: { path: "/plugin-manifest.json", port: 9443, scheme: "HTTPS" },
    });
  });

  test("restricted security context, read-only root, no fixed user", () => {
    const pod = deploymentSpec(docs).template.spec;
    expect(pod.securityContext).toEqual({ runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } });
    expect(pod.containers[0].securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
    expect(JSON.stringify(pod)).not.toContain("runAsUser");
  });

  test("mounts the serving certificate read-only at /var/cert and an emptyDir at /tmp, and nothing under /etc/nginx", () => {
    const pod = deploymentSpec(docs).template.spec;
    expect(pod.volumes).toEqual([
      { name: "plugin-serving-cert", secret: { secretName: `${SERVER}-cert`, defaultMode: 420 } },
      { name: "tmp", emptyDir: {} },
    ]);
    expect(pod.containers[0].volumeMounts).toEqual([
      { name: "plugin-serving-cert", mountPath: "/var/cert", readOnly: true },
      { name: "tmp", mountPath: "/tmp" },
    ]);
  });

  test("the same render holds the locator ConsoleLink the plugin reads", () => {
    const link = one(docs, "ConsoleLink", "libredb-studio");
    expect(link.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
  });

  test("names stay fixed under fullnameOverride and another release name", () => {
    const run = Bun.spawnSync(
      ["helm", "template", "other", CHART_DIR, "--namespace", NAMESPACE, ...PLUGIN_ON, ...set("fullnameOverride=x")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).toBe(0);
    RENDERED.push(run.stdout.toString());
    const other = parseAllDocuments(run.stdout.toString())
      .map((doc) => doc.toJSON() as Manifest)
      .filter(Boolean);
    one(other, "ConsolePlugin", "libredb-studio");
    for (const kind of ["ServiceAccount", "Deployment", "Service"]) one(other, kind, SERVER);
  });

  test("the server's labels are its own: the release's topology labels stay off it", () => {
    const topology = render([
      ...PLUGIN_ON,
      ...set("openshift.topology.partOf=foo-operator", "openshift.topology.runtime=nginx"),
    ]);
    const own = one(topology, "ServiceAccount", SERVER).metadata.labels ?? {};
    expect(own).toMatchObject({ "app.kubernetes.io/component": "console-plugin" });
    expect(one(topology, "Deployment", SERVER).metadata.labels).toEqual(own);
    expect(deploymentSpec(topology).template.metadata.labels).toEqual(own);
  });

  test("the values set the replicas, pull policy, resources and image", () => {
    const image = `registry.example/mirror/plugin@sha256:${"c".repeat(64)}`;
    const spec = deploymentSpec(
      render([
        ...PLUGIN_ON,
        ...set(
          "openshift.consolePlugin.replicas=3",
          "openshift.consolePlugin.imagePullPolicy=Always",
          `openshift.consolePlugin.image=${image}`,
          "openshift.consolePlugin.resources.limits.memory=128Mi",
        ),
      ]),
    );
    expect(spec.replicas).toBe(3);
    expect(spec.template.spec.containers[0]).toMatchObject({
      image,
      imagePullPolicy: "Always",
      resources: { requests: { cpu: "10m", memory: "50Mi" }, limits: { memory: "128Mi" } },
    });
  });
});

describe("the plugin server's NetworkPolicy", () => {
  test("admits only the console's namespace on 9443 and allows no egress", () => {
    const docs = render(PLUGIN_ON);
    const policy = one(docs, "NetworkPolicy", SERVER);
    expect(policy.metadata.namespace).toBe(PLUGIN_NAMESPACE);
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { "app.kubernetes.io/name": SERVER, "app.kubernetes.io/instance": RELEASE } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openshift-console" } } }],
          ports: [{ protocol: "TCP", port: 9443 }],
        },
      ],
      egress: [],
    });
    expect((policy.spec as { podSelector: { matchLabels: unknown } }).podSelector.matchLabels).toEqual(
      deploymentSpec(docs).selector.matchLabels,
    );
  });

  test("selects none of Studio's pods, and Studio's own policy none of the server's", () => {
    const docs = render(PLUGIN_ON);
    const studioLabels = one(docs, "Deployment", "studio-libredb-studio").spec as unknown as DeploymentSpec;
    const pluginSelector = deploymentSpec(docs).selector.matchLabels;
    const matches = (selector: Record<string, string>, labels: Record<string, string>) =>
      Object.entries(selector).every(([key, value]) => labels[key] === value);
    expect(matches(pluginSelector, studioLabels.template.metadata.labels)).toBe(false);
    expect(matches(studioLabels.selector.matchLabels, deploymentSpec(docs).template.metadata.labels)).toBe(false);
  });

  test("is not rendered without the plugin", () => {
    const docs = render(pluginOn({ "openshift.consolePlugin.enabled": "false" }));
    expect(docs.filter((doc) => doc.kind === "NetworkPolicy" && doc.metadata.name === SERVER)).toEqual([]);
  });
});

/**
 * Guard (6) in action. helm template has no cluster, so lookup returns nothing; a private copy of the chart
 * replaces the one lookup call with the Namespace a project request creates, which carries openshift.io/requester.
 */
describe("guard (6) with a Namespace in place of the lookup", () => {
  const LOOKUP = 'lookup "v1" "Namespace" "" $checked';
  const REQUESTED = '(dict "metadata" (dict "annotations" (dict "openshift.io/requester" "dev-a")))';
  let requested: string;
  let created: string;
  let releaseRequested: string;

  function chartWith(namespace: string): string {
    const chart = mkdtempSync(join(tmpdir(), "libredb-console-plugin-lookup-"));
    cpSync(CHART_DIR, chart, { recursive: true });
    expect(helpers.split(LOOKUP)).toHaveLength(2);
    writeFileSync(join(chart, "templates/_helpers.tpl"), helpers.replace(LOOKUP, namespace));
    return chart;
  }

  beforeAll(() => {
    requested = chartWith(REQUESTED);
    created = chartWith('(dict "metadata" (dict "annotations" (dict "openshift.io/sa.scc.uid-range" "1000/10000")))');
    releaseRequested = chartWith(`(ternary ${REQUESTED} (dict) (eq $checked "${NAMESPACE}"))`);
  });

  afterAll(() => {
    for (const chart of [requested, created, releaseRequested]) rmSync(chart, { recursive: true, force: true });
  });

  test("refuses a project dev-a requested, and says how to make the namespace instead", () => {
    refusedIn(
      requested,
      PLUGIN_ON,
      `openshift.consolePlugin.namespace ${PLUGIN_NAMESPACE} is a project dev-a requested`,
      "every console session",
      `oc create namespace ${PLUGIN_NAMESPACE}`,
      `oc adm policy who-can update deployments.apps -n ${PLUGIN_NAMESPACE}`,
    );
  });

  test("accepts namespaces no project request made, on both paths", () => {
    expect(template(PLUGIN_ON, created).exitCode).toBe(0);
    expect(template(operatorOn(), created).exitCode).toBe(0);
  });

  test("on the Helm path, refuses a release namespace that is a requested project, by the cluster Studio namespace rule", () => {
    refusedIn(
      releaseRequested,
      PLUGIN_ON,
      `openshift.consolePlugin.enabled is true and this release's namespace ${NAMESPACE} is a project dev-a requested`,
      "the cluster Studio namespace rule",
      "only cluster admins may hold RoleBindings there",
      "oc create namespace",
    );
  });

  test("leaves a release in a requested project alone while the plugin is off", () => {
    expect(template(pluginOn({ "openshift.consolePlugin.enabled": "false" }), releaseRequested).exitCode).toBe(0);
  });

  test("under the operator, refuses an operator namespace that is a requested project", () => {
    refusedIn(
      requested,
      operatorOn(),
      `openshift.consolePlugin.namespace ${NAMESPACE} is a project dev-a requested`,
      `oc create namespace ${NAMESPACE}`,
    );
  });
});

/**
 * The enable patch the notes and docs/OPENSHIFT.md print, the block from a line holding only "(" to its ")". A cluster
 * admin pastes it into an interactive shell, so its exit and its set -eu must stay in the subshell: run it with a stub
 * oc, then a failing command, and the shell still reaches the line after it.
 */
function expectEnableSnippetBehaves(text: string, plugins: string, patch: string | null): void {
  const block = /^([ \t]*)\(\n[\s\S]*?\n\1\)$/m.exec(text)?.[0];
  expect(block).toBeDefined();
  expect(block).toContain("set -eu");
  const stub = mkdtempSync(join(tmpdir(), "libredb-enable-snippet-"));
  try {
    writeFileSync(
      join(stub, "oc"),
      '#!/bin/sh\nif [ "$1" = get ]; then printf %s "$STUB_PLUGINS"; else echo "oc $*"; fi\n',
      { mode: 0o755 },
    );
    const run = Bun.spawnSync(["bash", "-c", `${block}\nfalse\necho still-running`], {
      env: { PATH: `${stub}:${process.env.PATH}`, STUB_PLUGINS: plugins },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = run.stdout.toString();
    expect(stdout).toContain("still-running");
    if (patch === null) expect(stdout).not.toContain("oc patch");
    else expect(stdout).toContain(patch);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
}

describe("install notes with the console plugin", () => {
  // helm template never emits NOTES.txt, so the real file is wrapped in a named template inside a private copy of the
  // chart and rendered into a ConfigMap, as tests/unit/helm-chart-openshift-mode.test.ts does.
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  let notesChart: string;

  beforeAll(() => {
    notesChart = mkdtempSync(join(tmpdir(), "libredb-console-plugin-notes-probe-"));
    cpSync(CHART_DIR, notesChart, { recursive: true });
    writeFileSync(
      join(notesChart, PROBE_TEMPLATE),
      `{{- define "notesProbe" -}}\n${readFileSync(join(CHART_DIR, "templates/NOTES.txt"), "utf8")}\n{{- end -}}\n` +
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-probe\ndata:\n  notes: {{ include "notesProbe" . | quote }}\n',
    );
  });

  afterAll(() => rmSync(notesChart, { recursive: true, force: true }));

  function notes(args: string[]): string {
    const run = template([...args, "--show-only", PROBE_TEMPLATE], notesChart);
    if (run.exitCode !== 0) throw new Error(`helm template of the notes probe failed: ${run.stderr}`);
    const rendered = parseAllDocuments(run.stdout)
      .map((doc) => doc.toJS() as { data?: { notes?: string } } | null)
      .find((doc) => doc?.data?.notes !== undefined);
    return rendered?.data?.notes ?? "";
  }

  test("names the plugin namespace, who may write it, and how a cluster admin turns the plugin on and off", () => {
    const text = notes(PLUGIN_ON);
    expect(text).toContain(`OpenShift console plugin: server libredb-studio-console-plugin in ${PLUGIN_NAMESPACE}`);
    expect(text).toContain(`oc adm policy who-can update deployments.apps -n ${PLUGIN_NAMESPACE}`);
    expect(text).toContain("system:image-pullers");
    expect(text).not.toContain(`only cluster admins may hold RoleBindings in ${PLUGIN_NAMESPACE}`);
    expect(text).toContain(
      `With the plugin on, ${NAMESPACE} falls under the cluster Studio namespace rule: only cluster admins may hold RoleBindings there`,
    );
    expect(text).toContain("oc create namespace");
    expect(text).toContain("Console plugins");
    expect(text).toContain("/spec/plugins/-");
    expect(text).toContain('case "$plugins" in *\'"libredb-studio"\'*) exit 0 ;; esac');
    expect(text).toContain("remove libredb-studio from spec.plugins");
    expect(text).toContain(`before deleting ${PLUGIN_NAMESPACE} or ${NAMESPACE}`);
  });

  test.each([
    ['["libredb-studio"]', null],
    ["", '"path":"/spec/plugins","value":["libredb-studio"]'],
    ['["other"]', '"path":"/spec/plugins/-","value":"libredb-studio"'],
  ])("the enable patch leaves the pasting shell running (spec.plugins %p)", (plugins, patch) => {
    expectEnableSnippetBehaves(notes(PLUGIN_ON), plugins, patch);
  });

  test("under the operator, leaves the turning on to the install form and the console", () => {
    const text = notes(operatorOn());
    expect(text).toContain(`OpenShift console plugin: server libredb-studio-console-plugin in ${NAMESPACE}`);
    expect(text).toContain("the operator's own namespace");
    expect(text).not.toContain("oc create namespace");
    expect(text).not.toContain("falls under the cluster Studio namespace rule");
  });

  test("says nothing of it without the plugin", () => {
    const text = notes(pluginOn({ "openshift.consolePlugin.enabled": "false" }));
    expect(text).not.toContain("/spec/plugins/-");
    expect(text).not.toContain("oc create namespace");
    expect(text).toContain(
      "openshift.consolePlugin.enabled adds the OpenShift console plugin and openshift.consoleLink.enabled a link to Studio in the console.",
    );
  });
});

describe("the chart README documents the console plugin", () => {
  const readme = readFileSync(join(CHART_DIR, "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("### The console plugin"),
    readme.indexOf("### The cluster's trusted CA bundle"),
  );

  test.each([
    "OpenShift 4.19 or later",
    "oc create namespace",
    "oc adm policy who-can update deployments.apps -n",
    "system:image-pullers",
    "--reset-then-reuse-values",
    "before deleting the plugin namespace or Studio's namespace",
    "openshift.io/requester",
    "`helm template` and a client-side dry run skip it",
    "openshift-console",
    "no proxy and no content security policy",
    "Console plugins",
    "spec.plugins",
    "The chart renders no Job",
    "the release's namespace falls under the [cluster Studio namespace](https://github.com/libredb/libredb-studio/blob/main/docs/OPENSHIFT.md#the-cluster-studio-namespace) rule",
    "only cluster admins may hold RoleBindings there",
    "the server's name `libredb-studio-console-plugin`",
    "An upgrade with `--reuse-values` from chart 0.1.117 or earlier",
  ])("names %s", (needle) => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain(needle);
  });

  test("says the details item shows on the generic details page only, not on the operator's operand page", () => {
    expect(section).toContain("generic details page");
    expect(section).toContain("operand details page that Installed Operators opens");
  });

  test("puts the server in the operator's own namespace under the operator, and refuses Studio's only on a Helm install", () => {
    expect(section).toContain("Under the OLM operator the server runs in the operator's own namespace");
    expect(section).toContain("on a Helm install, is the release's own namespace");
    expect(section).not.toContain("is the release's own namespace or is listed");
    expect(section).not.toContain("on a Helm install, is the release's own namespace or a project someone requested");
  });

  test("every new value is in the configuration reference", () => {
    for (const key of Object.keys(values.openshift.consolePlugin)) {
      expect(readme).toContain(`| \`openshift.consolePlugin.${key}\` |`);
    }
  });
});

describe("docs/OPENSHIFT.md on the console plugin", () => {
  const doc = readFileSync(join(import.meta.dir, "../../docs/OPENSHIFT.md"), "utf8");
  const plugin = doc.slice(
    doc.indexOf("## The console plugin"),
    doc.indexOf("\n## ", doc.indexOf("## The console plugin") + 1),
  );
  const uninstall = doc.slice(doc.indexOf("## Uninstall"));

  test.each([
    ['["libredb-studio"]', null],
    ["", '"path":"/spec/plugins","value":["libredb-studio"]'],
    ['["other"]', '"path":"/spec/plugins/-","value":"libredb-studio"'],
  ])("the enable patch leaves the pasting shell running (spec.plugins %p)", (plugins, patch) => {
    expectEnableSnippetBehaves(plugin, plugins, patch);
  });

  test("says the details item shows on the generic details page only, not on the operator's operand page", () => {
    expect(plugin).toContain("generic details page");
    expect(plugin).toContain("operand details page that Installed Operators opens");
  });

  test("puts the server in the operator's own namespace, the cluster Studio namespace, under the operator", () => {
    expect(plugin).toContain("the server runs in the operator's own namespace, the cluster Studio namespace");
    expect(plugin).toContain("any other plugin namespace fails");
    expect(doc).not.toContain("openshift-operators` for the AllNamespaces install");
  });

  test("names who-can as the check, and the system bindings every namespace holds", () => {
    expect(plugin).toContain("oc adm policy who-can update deployments.apps -n <namespace>");
    expect(plugin).toContain("system:image-pullers");
    expect(plugin).not.toContain("lists only cluster-admin bindings");
  });

  test("puts the release's namespace under the cluster Studio namespace rule while the plugin is on", () => {
    expect(plugin).toContain(
      "the release's namespace falls under the [cluster Studio namespace](#the-cluster-studio-namespace) rule",
    );
    expect(plugin).toContain("only cluster admins may hold RoleBindings there");
    expect(plugin).not.toContain("the server's NetworkPolicy and labels are its own");
  });

  test("Uninstall removes the ConsolePlugin before the namespaces it names", () => {
    expect(uninstall.length).toBeGreaterThan(0);
    expect(uninstall).toContain("before deleting the plugin namespace or Studio's namespace");
  });
});

describe("docs/HELM_CHART.md on the console plugin guards", () => {
  const doc = readFileSync(join(import.meta.dir, "../../docs/HELM_CHART.md"), "utf8");
  const guards = doc.slice(doc.indexOf("**Guards.** `consolePluginGuards`"), doc.indexOf("**NetworkPolicy.**"));

  test("guard 3 says an unset WATCH_NAMESPACE is answered by guard 2 first", () => {
    expect(guards).toContain(
      "3. An empty `namespace`; under the operator an unset `WATCH_NAMESPACE` empties `operator.clusterStudioNamespace` too, so guard 2 answers first.",
    );
    expect(guards).not.toContain("(and under the operator, an unset `WATCH_NAMESPACE`)");
  });

  test("guard 6 runs on both paths and checks the release's namespace on the Helm path", () => {
    expect(guards).toContain(
      "6. On both paths, the plugin namespace, and on the Helm path also the release's namespace",
    );
    expect(guards).not.toContain("On the Helm path only");
  });

  test("guard 9 refuses a Studio name equal to the server's", () => {
    expect(guards).toContain("9. A `nameOverride`, `fullnameOverride` or release name");
  });
});

describe("security control 3.37 and the chart's release notes", () => {
  const security = readFileSync(join(import.meta.dir, "../../docs/SECURITY.md"), "utf8");
  const row = security.split("\n").find((line) => line.startsWith("| 3.37 |")) ?? "";
  const chartYaml = readFileSync(join(CHART_DIR, "Chart.yaml"), "utf8");

  test("the row refuses Studio's namespace on a Helm install and pins the operator's own namespace under the operator", () => {
    expect(row).toContain("never runs in Studio's namespace on a Helm install");
    expect(row).toContain("under the operator it runs only in the operator's own namespace (row 3.36)");
    expect(row).toContain("where the render can look the namespace up");
    expect(row).toContain("the release's own namespace may then not be a requested project either");
    expect(row).toContain("[`operator/config/manager/manager.yaml`]");
  });

  test("Chart.yaml's change entry names the operator's own namespace", () => {
    const changes = chartYaml.slice(chartYaml.indexOf("artifacthub.io/changes:"));
    expect(changes).toContain("under the OLM operator, in the operator's own namespace");
    expect(chartYaml).toContain("# False: 0.1.118 adds openshift.consolePlugin");
  });
});

/**
 * Runs last: every render the cases above made. No standing right comes from the plugin wiring, and nothing the
 * chart renders may change the console's configuration (consoles.operator.openshift.io), which only a cluster admin
 * edits to turn the plugin on.
 */
describe("across every render of this file", () => {
  test("console-plugin.yaml renders no Job, CronJob, ClusterRole or ClusterRoleBinding", () => {
    const fromPlugin = RENDERED.flatMap(sourced).filter(({ source }) =>
      source.endsWith("/templates/console-plugin.yaml"),
    );
    expect(fromPlugin.some(({ doc }) => doc.kind === "ConsolePlugin")).toBe(true);
    expect(new Set(fromPlugin.map(({ doc }) => doc.kind))).toEqual(
      new Set(["ServiceAccount", "Deployment", "Service", "NetworkPolicy", "ConsolePlugin"]),
    );
  });

  test("no object grants a verb on consoles.operator.openshift.io", () => {
    const rules = RENDERED.flatMap(sourced).flatMap(({ doc }) => doc.rules ?? []);
    expect(rules.length).toBeGreaterThan(0);
    const consoleRules = rules.filter(
      (rule) =>
        (rule.apiGroups ?? []).some((group) => group === "operator.openshift.io" || group === "*") &&
        (rule.resources ?? []).some((resource) => resource === "consoles" || resource === "*"),
    );
    expect(consoleRules).toEqual([]);
  });
});
