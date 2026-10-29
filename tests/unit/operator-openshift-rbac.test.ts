// @requires helm
/**
 * The operator's manager role in openshift mode: exactly the reviewed rules, and enough for what it renders.
 *
 * The operator is codeless: helm-operator installs the embedded chart with the controller's own
 * cluster-wide ServiceAccount. openshift mode renders a route.openshift.io Route with a fixed host,
 * a cluster-scoped ConsoleLink and, with Kubernetes discovery on, a Role in each discovered
 * namespace that lets the exporter list the database kinds. Kubernetes refuses to let anyone create
 * a Role that grants a verb the creator does not hold itself, so the manager role must hold every
 * (group, resource, verb) those Roles grant, and setting a Route's host needs create on
 * routes/custom-host (OP23).
 *
 * Every rule the role holds is listed below as the reviewed list, so a rule added or removed is a
 * visible change to this file. The escalation test renders the chart the way the operator does in
 * openshift mode and checks every rule of every rendered Role against the role.
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

const MANAGE_VERBS = ["create", "delete", "get", "list", "patch", "update", "watch"];
const READ_VERBS = ["get", "list", "watch"];

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
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
  { apiGroups: ["route.openshift.io"], resources: ["routes/custom-host"], verbs: ["create"] },
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

  test("manages Routes and may set their host, which openshift mode fixes at install time", () => {
    const rules = roleRules();
    for (const verb of MANAGE_VERBS) expect(grants(rules, "route.openshift.io", "routes", verb)).toBe(true);
    expect(grants(rules, "route.openshift.io", "routes/custom-host", "create")).toBe(true);
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
