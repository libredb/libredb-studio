// @requires helm
/**
 * The operator's manager role in openshift mode: exactly the reviewed rules, and enough for what it renders.
 *
 * The operator is codeless: helm-operator installs the embedded chart with the controller's own
 * cluster-wide ServiceAccount. openshift mode renders a route.openshift.io Route with a fixed host,
 * a cluster-scoped ConsoleLink and, with Kubernetes discovery on, a Role in each discovered
 * namespace that lets the exporter list the database kinds. Kubernetes refuses to let anyone create
 * a Role that grants a verb the creator does not hold itself, so the manager role must hold every
 * (group, resource, verb) those Roles grant. Setting a Route's host needs create on
 * routes/custom-host, and changing it on an existing Route needs update there, or the API server
 * refuses the Route.
 *
 * Every rule the role holds is listed below as the reviewed list, so a rule added or removed is a
 * visible change to this file. The escalation test renders the chart the way the operator does in
 * openshift mode and checks every rule of every rendered Role against the role.
 *
 * The role is cluster-wide, so the resource must not choose where the operator puts objects. The
 * CRD refuses extraObjects (operator-crd-extra-objects.test.ts), and the bundled PostgreSQL subchart
 * gets the same treatment here: spec.postgresql takes only the values Studio's storage needs, the
 * API server drops any other key, and the values that would place the subchart's objects outside
 * the resource's namespace are refused with a message. operator/watches.yaml pins the same values
 * again at reconcile (operator-openshift-watches.test.ts), for a resource stored before this CRD.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/libredb-studio");
const RBAC_DIR = join(ROOT, "operator/config/rbac");
const ROLE = join(RBAC_DIR, "role.yaml");
const CRDS = {
  source: join(ROOT, "operator/config/crd/bases/studio.libredb.org_libredbstudios.yaml"),
  bundle: join(ROOT, "operator/bundle/manifests/studio.libredb.org_libredbstudios.yaml"),
};

/** The spec.postgresql keys the operator accepts: what Studio's storage needs, nothing else. */
const POSTGRESQL_ACCEPTED = [
  "auth",
  "commonLabels",
  "enabled",
  "image",
  "metrics",
  "primary",
  "tls",
  "volumePermissions",
];
/** Declared only so the API server refuses them with a message instead of dropping them. */
const POSTGRESQL_REFUSED = ["extraDeploy", "namespaceOverride"];

const MANAGE_VERBS = ["create", "delete", "get", "list", "patch", "update", "watch"];
const READ_VERBS = ["get", "list", "watch"];

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
}

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  "x-kubernetes-validations"?: Array<{ rule: string; message?: string }>;
}

function specSchema(file: string): Schema {
  const crd = parse(readFileSync(file, "utf8")) as {
    spec: { versions: Array<{ name: string; schema: { openAPIV3Schema: Schema } }> };
  };
  const spec = crd.spec.versions.find((v) => v.name === "v1alpha1")?.schema.openAPIV3Schema.properties?.spec;
  if (!spec) throw new Error(`no v1alpha1 spec schema in ${file}`);
  return spec;
}

function postgresqlSchema(file: string): Schema {
  const schema = specSchema(file).properties?.postgresql;
  if (!schema) throw new Error(`no spec.postgresql schema in ${file}`);
  return schema;
}

/** A string value the API server refuses unless it is empty, with a message naming the value. */
function expectRefusedUnlessEmpty(field: Schema | undefined, value: string): void {
  expect(field?.type).toBe("string");
  expect(field?.["x-kubernetes-validations"]).toEqual([
    { rule: "self == ''", message: expect.stringContaining(`${value} is not available through the operator`) },
  ]);
}

function manage(group: string, resources: string[]): Rule {
  return { apiGroups: [group], resources, verbs: MANAGE_VERBS };
}

/** The manager role, rule by rule, in file order. Change it only together with role.yaml. */
const REVIEWED_RULES: Rule[] = [
  { apiGroups: [""], resources: ["namespaces"], verbs: ["get"] },
  { apiGroups: [""], resources: ["secrets"], verbs: ["*"] },
  { apiGroups: [""], resources: ["events"], verbs: ["create"] },
  manage("studio.libredb.org", ["libredbstudios", "libredbstudios/status", "libredbstudios/finalizers"]),
  manage("", [
    "pods",
    "services",
    "services/finalizers",
    "endpoints",
    "persistentvolumeclaims",
    "events",
    "configmaps",
    "secrets",
    "serviceaccounts",
  ]),
  manage("apps", ["deployments", "daemonsets", "replicasets", "statefulsets"]),
  manage("networking.k8s.io", ["ingresses", "networkpolicies"]),
  manage("autoscaling", ["horizontalpodautoscalers"]),
  manage("policy", ["poddisruptionbudgets"]),
  manage("batch", ["jobs", "cronjobs"]),
  manage("rbac.authorization.k8s.io", ["roles", "rolebindings"]),
  manage("gateway.networking.k8s.io", ["httproutes"]),
  manage("monitoring.coreos.com", ["servicemonitors", "prometheusrules"]),
  manage("route.openshift.io", ["routes"]),
  { apiGroups: ["route.openshift.io"], resources: ["routes/custom-host"], verbs: ["create", "update"] },
  manage("console.openshift.io", ["consolelinks"]),
  { apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: READ_VERBS },
  { apiGroups: ["postgresql.k8s.enterprisedb.io"], resources: ["clusters"], verbs: READ_VERBS },
  { apiGroups: ["postgres-operator.crunchydata.com"], resources: ["postgresclusters"], verbs: READ_VERBS },
  { apiGroups: ["mongodbcommunity.mongodb.com"], resources: ["mongodbcommunity"], verbs: READ_VERBS },
];

/** The openshift-mode resource the operator reconciles, with discovery of every kind the chart knows. */
const OPENSHIFT_RENDER = [
  "--namespace",
  "release-under-test",
  "--set",
  "global.compatibility.openshift.apis=force",
  "--set",
  "authProvider=openshift",
  "--set",
  "image.tag=1.2.0",
  "--set",
  "openshiftRoute.enabled=true",
  "--set",
  "openshiftRoute.host=studio.apps.example.test",
  "--set",
  "openshift.consoleLink.enabled=true",
  "--set",
  "discovery.kubernetes.enabled=true",
  "--set",
  "discovery.kubernetes.namespaces={team-a,team-b}",
  "--set",
  "discovery.kubernetes.kinds={cnpg,edbpg,pgo,mongo}",
  "--set",
  "operator.managed=true",
  "--set",
  "operator.clusterStudioNamespace=release-under-test",
];

function roleRules(): Rule[] {
  return (parse(readFileSync(ROLE, "utf8")) as { rules: Rule[] }).rules;
}

function grants(rules: Rule[], group: string, resource: string, verb: string): boolean {
  return rules.some(
    (rule) =>
      rule.apiGroups?.includes(group) &&
      rule.resources?.includes(resource) &&
      (rule.verbs?.includes(verb) || rule.verbs?.includes("*")),
  );
}

function render(args: string[]): Array<Record<string, unknown>> {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr.toString()}`);
  }
  return parseAllDocuments(run.stdout.toString())
    .map((doc) => doc.toJSON() as Record<string, unknown> | null)
    .filter((doc): doc is Record<string, unknown> => doc != null);
}

describe("the manager role", () => {
  test("is exactly the reviewed list of rules", () => {
    expect(roleRules()).toEqual(REVIEWED_RULES);
  });

  test("manages Routes and may set their host, and change it when openshiftRoute.host changes", () => {
    const rules = roleRules();
    for (const verb of MANAGE_VERBS) expect(grants(rules, "route.openshift.io", "routes", verb)).toBe(true);
    expect(grants(rules, "route.openshift.io", "routes/custom-host", "create")).toBe(true);
    // The route admission check asks for update on routes/custom-host when spec.host changes,
    // and create when only the certificate fields change.
    expect(grants(rules, "route.openshift.io", "routes/custom-host", "update")).toBe(true);
  });

  test("manages ConsoleLinks but no ConsolePlugin, which is not shipped yet", () => {
    const rules = roleRules();
    for (const verb of MANAGE_VERBS) expect(grants(rules, "console.openshift.io", "consolelinks", verb)).toBe(true);
    expect(rules.some((rule) => rule.resources?.includes("consoleplugins"))).toBe(false);
  });

  test.each([
    ["postgresql.cnpg.io", "clusters"],
    ["postgresql.k8s.enterprisedb.io", "clusters"],
    ["postgres-operator.crunchydata.com", "postgresclusters"],
    ["mongodbcommunity.mongodb.com", "mongodbcommunity"],
  ])("reads %s %s and may not change them", (group, resource) => {
    const rules = roleRules();
    for (const verb of READ_VERBS) expect(grants(rules, group, resource, verb)).toBe(true);
    for (const verb of ["create", "delete", "patch", "update"]) {
      expect(grants(rules, group, resource, verb)).toBe(false);
    }
  });

  test("holds no access review, cluster RBAC or console plugin rule", () => {
    const resources = roleRules().flatMap((rule) => rule.resources ?? []);
    for (const resource of [
      "subjectaccessreviews",
      "selfsubjectaccessreviews",
      "tokenreviews",
      "clusterroles",
      "clusterrolebindings",
      "consoleplugins",
    ]) {
      expect(resources).not.toContain(resource);
    }
  });

  test("is bound to nothing that delegates authentication checks", () => {
    for (const file of readdirSync(RBAC_DIR)) {
      expect({ file, text: readFileSync(join(RBAC_DIR, file), "utf8").includes("system:auth-delegator") }).toEqual({
        file,
        text: false,
      });
    }
  });
});

describe("the openshift render under the operator", () => {
  const docs = render(OPENSHIFT_RENDER);

  test("renders a Role for the exporter in every discovered namespace, so the check below checks something", () => {
    const namespaces = docs
      .filter((doc) => doc.kind === "Role")
      .map((doc) => (doc.metadata as { namespace?: string }).namespace)
      .filter((namespace) => namespace != null);
    expect(namespaces.sort()).toEqual(["team-a", "team-b"]);
  });

  test("grants no rule in any rendered Role or ClusterRole that the manager role does not hold", () => {
    const rules = roleRules();
    const missing: string[] = [];
    for (const doc of docs.filter((d) => d.kind === "Role" || d.kind === "ClusterRole")) {
      for (const rule of (doc.rules as Rule[] | undefined) ?? []) {
        for (const group of rule.apiGroups ?? []) {
          for (const resource of rule.resources ?? []) {
            for (const verb of rule.verbs ?? []) {
              if (!grants(rules, group, resource, verb)) missing.push(`${group}/${resource} ${verb}`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe.each(Object.entries(CRDS))("the %s CRD's bundled PostgreSQL values", (_name, file) => {
  test("take only the accepted keys and the refused placement keys, and drop any other", () => {
    const schema = postgresqlSchema(file);
    expect(schema.type).toBe("object");
    expect(schema["x-kubernetes-preserve-unknown-fields"]).toBeUndefined();
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...POSTGRESQL_ACCEPTED, ...POSTGRESQL_REFUSED].sort());
  });

  test("refuse any extraDeploy item, with a message that names the reason", () => {
    const field = postgresqlSchema(file).properties?.extraDeploy;
    expect(field?.type).toBe("array");
    expect(field?.items).toEqual({ type: "object", "x-kubernetes-preserve-unknown-fields": true });
    expect(field?.["x-kubernetes-validations"]).toEqual([
      { rule: "size(self) == 0", message: expect.stringContaining("service account") },
    ]);
  });

  test("refuse a namespaceOverride, so the subchart runs in the resource's namespace", () => {
    expectRefusedUnlessEmpty(postgresqlSchema(file).properties?.namespaceOverride, "postgresql.namespaceOverride");
  });

  test("refuse a namespace for the ServiceMonitor and the PrometheusRule", () => {
    const metrics = postgresqlSchema(file).properties?.metrics;
    expect(metrics?.["x-kubernetes-preserve-unknown-fields"]).toBe(true);
    for (const kind of ["serviceMonitor", "prometheusRule"]) {
      const object = metrics?.properties?.[kind];
      expect(object?.["x-kubernetes-preserve-unknown-fields"]).toBe(true);
      expectRefusedUnlessEmpty(object?.properties?.namespace, `postgresql.metrics.${kind}.namespace`);
    }
  });

  test("keep enabled a boolean, commonLabels a map of strings and the other accepted values whole", () => {
    const properties = postgresqlSchema(file).properties ?? {};
    expect(properties.enabled).toEqual({ type: "boolean" });
    expect(properties.commonLabels).toEqual({ type: "object", additionalProperties: { type: "string" } });
    for (const key of ["auth", "image", "primary", "tls", "volumePermissions"]) {
      expect({ key, schema: properties[key] }).toEqual({
        key,
        schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
      });
    }
  });
});

describe("the values the CRD refuses are ones the bundled subchart renders, so each refusal guards something", () => {
  const base = ["--namespace", "release-under-test", "--set", "postgresql.enabled=true"];
  const namespaces = (args: string[]) =>
    render([...base, ...args])
      .map((doc) => (doc.metadata as { namespace?: string } | undefined)?.namespace)
      .filter((namespace) => namespace != null);

  test("the release's objects all stay in its namespace without them", () => {
    expect(new Set(namespaces([]))).toEqual(new Set(["release-under-test"]));
  });

  test("namespaceOverride moves the subchart's objects", () => {
    expect(namespaces(["--set", "postgresql.namespaceOverride=other-namespace"])).toContain("other-namespace");
  });

  test("extraDeploy adds a manifest of its own", () => {
    const docs = render([
      ...base,
      "--set-json",
      'postgresql.extraDeploy=[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"from-extra-deploy"}}]',
    ]);
    expect(docs.map((doc) => (doc.metadata as { name?: string }).name)).toContain("from-extra-deploy");
  });

  test("the metrics namespaces move the ServiceMonitor and the PrometheusRule", () => {
    const moved = namespaces([
      "--api-versions",
      "monitoring.coreos.com/v1",
      "--set",
      "postgresql.metrics.enabled=true",
      "--set",
      "postgresql.metrics.serviceMonitor.enabled=true",
      "--set",
      "postgresql.metrics.serviceMonitor.namespace=monitor-namespace",
      "--set",
      "postgresql.metrics.prometheusRule.enabled=true",
      "--set",
      "postgresql.metrics.prometheusRule.namespace=rule-namespace",
    ]);
    expect(moved).toContain("monitor-namespace");
    expect(moved).toContain("rule-namespace");
  });
});
