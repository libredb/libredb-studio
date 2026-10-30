// @requires helm
/**
 * The OpenShift console plugin in Studio's chart (openshift.consolePlugin).
 *
 * The plugin is a static bundle the console loads into every console session, served by an nginx
 * server that receives every console user's bearer token on each asset fetch. So whoever can change
 * that server's Deployment runs code in every console session and receives every console user's
 * token, and the chart refuses every place a person who is not a cluster admin could do that: Studio's
 * own namespace, a discovered namespace, and on the Helm path a project a user requested. The server
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
 * The plugin image the chart ships, pinned by digest. PROVISIONAL until the plugin's 0.1.0 release
 * is public: the digest is 64 zeros, and the case "pins a released digest" below stays red until
 * the released index digest replaces it.
 */
const PLUGIN_IMAGE = `ghcr.io/libredb/libredb-studio-openshift-plugin:0.1.0@sha256:${ZERO_DIGEST}`;

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

function template(args: string[], chart = CHART_DIR): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, chart, "--namespace", NAMESPACE, ...args], {
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
  refusedIn(CHART_DIR, args, ...needles);
}

function refusedIn(chart: string, args: string[], ...needles: string[]): void {
  const run = template(args, chart);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
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

  test("pins a released digest, never the provisional all-zero one", () => {
    // PROVISIONAL (S4): red until the plugin's 0.1.0 index digest replaces the zeros in values.yaml,
    // the operator's RELATED_IMAGE_PLUGIN and PLUGIN_IMAGE above, so a placeholder never ships.
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

  test("(3) under the operator, the empty namespace names OPERATOR_NAMESPACE", () => {
    refused(
      [
        ...pluginOn({ "openshift.consolePlugin.namespace": "" }),
        ...set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`),
      ],
      "openshift.consolePlugin.namespace is empty",
      "OPERATOR_NAMESPACE",
    );
  });

  test("(4) refuses the release's own namespace", () => {
    refused(
      pluginOn({ "openshift.consolePlugin.namespace": NAMESPACE }),
      `openshift.consolePlugin.namespace is ${NAMESPACE}, this release's own namespace`,
      "every console session",
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

  test("(6) on the Helm path only, looks the namespace up and refuses a project a user requested", () => {
    const guard = helpers.slice(
      helpers.indexOf('{{- define "libredb-studio.consolePluginGuards" -}}'),
      helpers.indexOf("{{- end }}\n\n", helpers.indexOf('{{- define "libredb-studio.consolePluginGuards" -}}')),
    );
    expect(guard).toMatch(
      /\{\{- if not \(include "libredb-studio\.operatorManaged" \.\) \}\}\n\{\{- \$object := lookup "v1" "Namespace" "" \$namespace \}\}\n/,
    );
    expect(guard).toContain('{{- if hasKey $annotations "openshift.io/requester" }}');
    expect(guard).toContain("oc create namespace");
    expect(guard).toContain("oc get rolebindings -n");
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

  test("(8) refuses an empty image", () => {
    refused(pluginOn({ "openshift.consolePlugin.image": "" }), "openshift.consolePlugin.image is empty");
  });

  test("(8) under the operator, the empty image names RELATED_IMAGE_PLUGIN", () => {
    refused(
      [
        ...pluginOn({ "openshift.consolePlugin.image": "" }),
        ...set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`),
      ],
      "openshift.consolePlugin.image is empty",
      "RELATED_IMAGE_PLUGIN",
    );
  });
});

/**
 * Guard (6) in action. helm template has no cluster, so lookup returns nothing; a private copy of the chart
 * replaces the one lookup call with the Namespace a project request creates, which carries openshift.io/requester.
 */
describe("guard (6) with a Namespace in place of the lookup", () => {
  const LOOKUP = 'lookup "v1" "Namespace" "" $namespace';
  let requested: string;
  let created: string;

  function chartWith(namespace: string): string {
    const chart = mkdtempSync(join(tmpdir(), "libredb-console-plugin-lookup-"));
    cpSync(CHART_DIR, chart, { recursive: true });
    expect(helpers.split(LOOKUP)).toHaveLength(2);
    writeFileSync(join(chart, "templates/_helpers.tpl"), helpers.replace(LOOKUP, namespace));
    return chart;
  }

  beforeAll(() => {
    requested = chartWith('(dict "metadata" (dict "annotations" (dict "openshift.io/requester" "dev-a")))');
    created = chartWith('(dict "metadata" (dict "annotations" (dict "openshift.io/sa.scc.uid-range" "1000/10000")))');
  });

  afterAll(() => {
    for (const chart of [requested, created]) rmSync(chart, { recursive: true, force: true });
  });

  test("refuses a project dev-a requested, and says how to make the namespace instead", () => {
    refusedIn(
      requested,
      PLUGIN_ON,
      `openshift.consolePlugin.namespace ${PLUGIN_NAMESPACE} is a project dev-a requested`,
      "every console session",
      `oc create namespace ${PLUGIN_NAMESPACE}`,
      `oc get rolebindings -n ${PLUGIN_NAMESPACE}`,
    );
  });

  test("accepts a namespace no project request made", () => {
    expect(template(PLUGIN_ON, created).exitCode).toBe(0);
  });

  test("is skipped under the operator, whose own namespace the operator pins", () => {
    const run = template(
      [...PLUGIN_ON, ...set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`)],
      requested,
    );
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
});
