// @requires helm
/**
 * The operator's manager rights in openshift mode: exactly the reviewed rules, and enough for what it renders.
 *
 * The operator is codeless: helm-operator installs the embedded chart with the controller's own
 * ServiceAccount. The operator manages only its own namespace (OwnNamespace install, WATCH_NAMESPACE
 * from the pod's namespace), so its rights are split in two. The Role manager-namespace-role
 * (namespace_role.yaml) holds everything a release renders in that namespace, the Helm release
 * Secrets and the LibreDBStudio kind included; OLM grants it there and nowhere else. The ClusterRole
 * manager-role (role.yaml) holds only what must reach other namespaces or cluster-scoped kinds:
 * discovery's Roles and RoleBindings, get on Secrets and Services and read on the four discovered
 * database kinds (which those Roles grant), ConsoleLinks, and get on Namespaces.
 *
 * openshift mode renders a route.openshift.io Route with a fixed host, a cluster-scoped ConsoleLink
 * and, with Kubernetes discovery on, a Role in each discovered namespace that lets the exporter list
 * the database kinds. Kubernetes refuses to let anyone create a Role that grants a verb the creator
 * does not hold in that namespace, so a Role in another namespace must be covered by the ClusterRole
 * alone, and one in the operator's namespace by the Role and the ClusterRole together. Setting a
 * Route's host needs create on routes/custom-host, and changing it on an existing Route needs update
 * there, or the API server refuses the Route.
 *
 * The ClusterRole holds no rule on libredbstudios and no list or watch on Secrets, so a controller
 * whose watch is widened past its namespace cannot fill its cache and exits instead of reconciling.
 *
 * Every rule is listed below as a reviewed list, so a rule added or removed is a visible change to
 * this file. The escalation test renders the chart the way the operator does in openshift mode and
 * checks every rule of every rendered Role against the rights the operator holds where it lands.
 *
 * The resource must not choose where the operator puts objects. The
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
const CLUSTER_ROLE = join(RBAC_DIR, "role.yaml");
const NAMESPACE_ROLE = join(RBAC_DIR, "namespace_role.yaml");
const RELEASE_NAMESPACE = "release-under-test";
const SERVICE_ACCOUNT = { kind: "ServiceAccount", name: "controller-manager", namespace: "system" };
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

/** The ClusterRole, rule by rule, in file order. Change it only together with role.yaml. */
const REVIEWED_CLUSTER_RULES: Rule[] = [
  { apiGroups: [""], resources: ["namespaces"], verbs: ["get"] },
  manage("rbac.authorization.k8s.io", ["roles", "rolebindings"]),
  { apiGroups: [""], resources: ["secrets", "services"], verbs: ["get"] },
  manage("console.openshift.io", ["consolelinks"]),
  { apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: READ_VERBS },
  { apiGroups: ["postgresql.k8s.enterprisedb.io"], resources: ["clusters"], verbs: READ_VERBS },
  { apiGroups: ["postgres-operator.crunchydata.com"], resources: ["postgresclusters"], verbs: READ_VERBS },
  { apiGroups: ["mongodbcommunity.mongodb.com"], resources: ["mongodbcommunity"], verbs: READ_VERBS },
];

/** The Role in the operator's namespace, rule by rule, in file order. Change it only together with namespace_role.yaml. */
const REVIEWED_NAMESPACE_RULES: Rule[] = [
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
  manage("gateway.networking.k8s.io", ["httproutes"]),
  manage("monitoring.coreos.com", ["servicemonitors", "prometheusrules"]),
  manage("route.openshift.io", ["routes"]),
  { apiGroups: ["route.openshift.io"], resources: ["routes/custom-host"], verbs: ["create", "update"] },
];

/** Cluster-scoped kinds a Role cannot grant: a rule on one in the Role would be a rule on nothing. */
const CLUSTER_SCOPED = [
  "namespaces",
  "nodes",
  "persistentvolumes",
  "clusterroles",
  "clusterrolebindings",
  "customresourcedefinitions",
  "consolelinks",
  "consoleplugins",
  "tokenreviews",
  "subjectaccessreviews",
];

/** The openshift-mode resource the operator reconciles, with discovery of every kind the chart knows. */
const OPENSHIFT_RENDER = [
  "--namespace",
  RELEASE_NAMESPACE,
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

interface RbacObject {
  kind: string;
  metadata: { name: string };
  rules?: Rule[];
  roleRef?: { apiGroup: string; kind: string; name: string };
  subjects?: Array<{ kind: string; name: string; namespace?: string }>;
}

function rbacObject(file: string): RbacObject {
  return parse(readFileSync(join(RBAC_DIR, file), "utf8")) as RbacObject;
}

function clusterRules(): Rule[] {
  return (parse(readFileSync(CLUSTER_ROLE, "utf8")) as { rules: Rule[] }).rules;
}

function namespaceRules(): Rule[] {
  return (parse(readFileSync(NAMESPACE_ROLE, "utf8")) as { rules: Rule[] }).rules;
}

/** What the operator holds in a namespace: the Role there only in its own, the ClusterRole everywhere. */
function rulesIn(namespace: string): Rule[] {
  return namespace === RELEASE_NAMESPACE ? [...namespaceRules(), ...clusterRules()] : clusterRules();
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

describe("the manager ClusterRole", () => {
  test("is exactly the reviewed list of cluster-wide rules", () => {
    expect(rbacObject("role.yaml").kind).toBe("ClusterRole");
    expect(rbacObject("role.yaml").metadata.name).toBe("manager-role");
    expect(clusterRules()).toEqual(REVIEWED_CLUSTER_RULES);
  });

  test("holds no rule on LibreDBStudios, so a watch wider than the operator's namespace cannot sync", () => {
    const operatorGroup = "studio.libredb.org";
    expect(clusterRules().filter((rule) => (rule.apiGroups ?? []).some((group) => group === operatorGroup))).toEqual(
      [],
    );
    expect(clusterRules().flatMap((rule) => rule.resources ?? [])).not.toContain("libredbstudios");
  });

  test.each(["secrets", "services"])("may only get %s outside the operator's namespace", (resource) => {
    const verbs = clusterRules()
      .filter((rule) => rule.apiGroups?.includes("") && rule.resources?.includes(resource))
      .flatMap((rule) => rule.verbs ?? []);
    expect(verbs).toEqual(["get"]);
  });

  test("may create no workload, Service, account, ConfigMap, NetworkPolicy, Job or route outside its namespace", () => {
    const rules = clusterRules();
    for (const [group, resource] of [
      ["apps", "deployments"],
      ["", "pods"],
      ["", "services"],
      ["", "serviceaccounts"],
      ["", "configmaps"],
      ["", "secrets"],
      ["networking.k8s.io", "networkpolicies"],
      ["batch", "jobs"],
      ["route.openshift.io", "routes"],
      ["gateway.networking.k8s.io", "httproutes"],
    ]) {
      expect({ group, resource, create: grants(rules, group, resource, "create") }).toEqual({
        group,
        resource,
        create: false,
      });
    }
  });

  test("manages ConsoleLinks but no ConsolePlugin, which is not shipped yet", () => {
    const rules = clusterRules();
    for (const verb of MANAGE_VERBS) expect(grants(rules, "console.openshift.io", "consolelinks", verb)).toBe(true);
    expect([...rules, ...namespaceRules()].some((rule) => rule.resources?.includes("consoleplugins"))).toBe(false);
  });

  test.each([
    ["postgresql.cnpg.io", "clusters"],
    ["postgresql.k8s.enterprisedb.io", "clusters"],
    ["postgres-operator.crunchydata.com", "postgresclusters"],
    ["mongodbcommunity.mongodb.com", "mongodbcommunity"],
  ])("reads %s %s and may not change them", (group, resource) => {
    const rules = [...clusterRules(), ...namespaceRules()];
    for (const verb of READ_VERBS) expect(grants(clusterRules(), group, resource, verb)).toBe(true);
    for (const verb of ["create", "delete", "patch", "update"]) {
      expect(grants(rules, group, resource, verb)).toBe(false);
    }
  });

  test("is bound cluster-wide to the controller's ServiceAccount", () => {
    expect(rbacObject("role_binding.yaml")).toMatchObject({
      kind: "ClusterRoleBinding",
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "manager-role" },
      subjects: [SERVICE_ACCOUNT],
    });
  });
});

describe("the manager Role in the operator's namespace", () => {
  test("is exactly the reviewed list of namespaced rules", () => {
    expect(rbacObject("namespace_role.yaml").kind).toBe("Role");
    expect(rbacObject("namespace_role.yaml").metadata.name).toBe("manager-namespace-role");
    expect(namespaceRules()).toEqual(REVIEWED_NAMESPACE_RULES);
  });

  test("holds no cluster-scoped resource", () => {
    const resources = namespaceRules().flatMap((rule) => rule.resources ?? []);
    for (const resource of CLUSTER_SCOPED) expect(resources).not.toContain(resource);
  });

  test("manages Routes and may set their host, and change it when openshiftRoute.host changes", () => {
    const rules = namespaceRules();
    for (const verb of MANAGE_VERBS) expect(grants(rules, "route.openshift.io", "routes", verb)).toBe(true);
    expect(grants(rules, "route.openshift.io", "routes/custom-host", "create")).toBe(true);
    // The route admission check asks for update on routes/custom-host when spec.host changes,
    // and create when only the certificate fields change.
    expect(grants(rules, "route.openshift.io", "routes/custom-host", "update")).toBe(true);
  });

  test("is bound in the operator's namespace to the controller's ServiceAccount", () => {
    expect(rbacObject("namespace_role_binding.yaml")).toMatchObject({
      kind: "RoleBinding",
      metadata: { name: "manager-namespace-rolebinding" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "manager-namespace-role" },
      subjects: [SERVICE_ACCOUNT],
    });
  });
});

describe("the manager rights together", () => {
  test("are both in the kustomization, the Role and its binding after the ClusterRole's", () => {
    const resources = (parse(readFileSync(join(RBAC_DIR, "kustomization.yaml"), "utf8")) as { resources: string[] })
      .resources;
    const at = (file: string) => resources.indexOf(file);
    expect(at("role.yaml")).toBeGreaterThanOrEqual(0);
    expect(at("role_binding.yaml")).toBeGreaterThan(at("role.yaml"));
    expect(at("namespace_role.yaml")).toBe(at("role_binding.yaml") + 1);
    expect(at("namespace_role_binding.yaml")).toBe(at("namespace_role.yaml") + 1);
  });

  test("hold no access review, cluster RBAC or console plugin rule", () => {
    const resources = [...clusterRules(), ...namespaceRules()].flatMap((rule) => rule.resources ?? []);
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

  test("are bound to nothing that delegates authentication checks", () => {
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

  test("renders a Role in the release namespace and in every discovered namespace, so the check below checks both", () => {
    expect(docs.some((doc) => doc.kind === "Role" && (doc.metadata as { namespace?: string }).namespace == null)).toBe(
      true,
    );
    const namespaces = docs
      .filter((doc) => doc.kind === "Role")
      .map((doc) => (doc.metadata as { namespace?: string }).namespace)
      .filter((namespace) => namespace != null);
    expect(namespaces.sort()).toEqual(["team-a", "team-b"]);
  });

  test("grants no rule in any rendered Role or ClusterRole that the operator does not hold where it lands", () => {
    const missing: string[] = [];
    for (const doc of docs.filter((d) => d.kind === "Role" || d.kind === "ClusterRole")) {
      // A ClusterRole is cluster-wide, so only the ClusterRole covers it; a Role, what the operator holds
      // where it lands, the release namespace when the chart names none.
      const namespace = (doc.metadata as { namespace?: string }).namespace ?? RELEASE_NAMESPACE;
      const rules = doc.kind === "Role" ? rulesIn(namespace) : clusterRules();
      for (const rule of (doc.rules as Rule[] | undefined) ?? []) {
        for (const group of rule.apiGroups ?? []) {
          for (const resource of rule.resources ?? []) {
            for (const verb of rule.verbs ?? []) {
              if (!grants(rules, group, resource, verb))
                missing.push(`${doc.kind} ${namespace}: ${group}/${resource} ${verb}`);
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
