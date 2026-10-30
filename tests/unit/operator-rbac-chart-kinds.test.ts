// @requires helm
/**
 * The operator's manager rights cover every kind the embedded chart renders.
 *
 * The operator is codeless: helm-operator installs the embedded chart with the
 * controller's own ServiceAccount, so a kind the chart renders that the operator
 * holds no rule for fails the whole release. A LibreDBStudio with
 * route.main.enabled did exactly that on OpenShift 4.22.14: ReleaseFailed,
 * "cannot get resource httproutes in API group gateway.networking.k8s.io", and
 * nothing was created in the namespace.
 *
 * The operator manages only its own namespace, so its rights come in two parts:
 * the Role operator/config/rbac/namespace_role.yaml in that namespace, and the
 * ClusterRole operator/config/rbac/role.yaml everywhere. An object in the release
 * namespace may draw its verbs from both; an object in another namespace, or of a
 * cluster-scoped kind, from the ClusterRole alone.
 *
 * Each render below turns on one feature flag the rights already serve, plus
 * route.main and the openshift-mode resource the operator reconciles (its Route,
 * ConsoleLink and the discovery Roles), and every kind it renders must have the
 * same verbs the operator holds for the kinds it already manages. Flags whose
 * kinds the operator does not manage (accessReview, the Rancher NavLink) are not
 * listed: granting those is a decision of its own. `make -C operator bundle`
 * turns the ClusterRole, bound by a ClusterRoleBinding, into the CSV's
 * clusterPermissions, followed by the metrics auth role, and the Roles bound by
 * RoleBindings into its permissions, the leader election role first, in the
 * order of operator/config/rbac/kustomization.yaml.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const ROOT = join(import.meta.dir, "../..");
// The operator embeds a byte copy of charts/libredb-studio (bun run chart:check fails on any drift), and CI
// vendors the PostgreSQL subchart only for charts/libredb-studio, so the render reads that copy.
const CHART_DIR = join(ROOT, "charts/libredb-studio");
const RELEASE_NAMESPACE = "release-under-test";
const CLUSTER_ROLE = join(ROOT, "operator/config/rbac/role.yaml");
const NAMESPACE_ROLE = join(ROOT, "operator/config/rbac/namespace_role.yaml");
const METRICS_AUTH_ROLE = join(ROOT, "operator/config/rbac/metrics_auth_role.yaml");
const LEADER_ELECTION_ROLE = join(ROOT, "operator/config/rbac/leader_election_role.yaml");
/** The cluster-scoped kinds the chart renders, which a Role in the release namespace cannot grant. */
const CLUSTER_SCOPED_KINDS = new Set(["ConsoleLink", "ConsolePlugin", "ClusterRole", "ClusterRoleBinding"]);
const CSV = join(ROOT, "operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml");

const MANAGE_VERBS = ["create", "delete", "get", "list", "patch", "update", "watch"];

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

const RENDERS: Record<string, string[]> = {
  "default values": [],
  "route.main.enabled": ["--set", "route.main.enabled=true", "--set", "route.main.parentRefs[0].name=gw"],
  "ingress.enabled": ["--set", "ingress.enabled=true"],
  "networkPolicy.enabled": ["--set", "networkPolicy.enabled=true"],
  "autoscaling.enabled": [
    "--set",
    "autoscaling.enabled=true",
    "--set",
    "secrets.jwtSecret=a-test-secret-of-32-characters-xx",
  ],
  "podDisruptionBudget.enabled": ["--set", "podDisruptionBudget.enabled=true"],
  // The operator's view: its O14 override names this release's namespace, and the
  // Route and ConsoleLink render offline only with the OpenShift APIs forced.
  "authProvider=openshift under the operator": [
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
    "discovery.kubernetes.namespaces={team-a}",
    "--set",
    "discovery.kubernetes.kinds={cnpg,edbpg,pgo,mongo}",
    "--set",
    "operator.managed=true",
    "--set",
    "operator.clusterStudioNamespace=release-under-test",
  ],
};

/** The kind each render must contain, so no render passes on an empty output. */
const EXPECTED_KIND: Record<string, string> = {
  "default values": "Deployment",
  "route.main.enabled": "HTTPRoute",
  "ingress.enabled": "Ingress",
  "networkPolicy.enabled": "NetworkPolicy",
  "autoscaling.enabled": "HorizontalPodAutoscaler",
  "podDisruptionBudget.enabled": "PodDisruptionBudget",
  "authProvider=openshift under the operator": "ConsoleLink",
};

interface RenderedObject {
  group: string;
  kind: string;
  /** Where the object lands: its own namespace, the release namespace, or null for a cluster-scoped kind. */
  namespace: string | null;
}

function renderedObjects(args: string[]): RenderedObject[] {
  // Every render runs in the release namespace, so an object the chart places there is told apart from one elsewhere.
  const run = Bun.spawnSync(
    ["helm", "template", "release-under-test", CHART_DIR, "--namespace", RELEASE_NAMESPACE, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr.toString()}`);
  }
  return parseAllDocuments(run.stdout.toString())
    .map((doc) => doc.toJSON() as { apiVersion: string; kind: string; metadata?: { namespace?: string } } | null)
    .filter((doc) => doc != null)
    .map((doc) => ({
      group: doc.apiVersion.includes("/") ? doc.apiVersion.split("/")[0] : "",
      kind: doc.kind,
      namespace: CLUSTER_SCOPED_KINDS.has(doc.kind) ? null : (doc.metadata?.namespace ?? RELEASE_NAMESPACE),
    }));
}

function renderedKinds(args: string[]): Array<{ group: string; kind: string }> {
  return renderedObjects(args).map(({ group, kind }) => ({ group, kind }));
}

function plural(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith("y")) return `${lower.slice(0, -1)}ies`;
  if (lower.endsWith("s")) return `${lower}es`;
  return `${lower}s`;
}

function rulesOf(file: string): Rule[] {
  return (parse(readFileSync(file, "utf8")) as { rules: Rule[] }).rules;
}

function clusterRules(): Rule[] {
  return rulesOf(CLUSTER_ROLE);
}

function namespaceRules(): Rule[] {
  return rulesOf(NAMESPACE_ROLE);
}

/** The rights the operator holds where an object lands. */
function rulesFor(namespace: string | null): Rule[] {
  return namespace === RELEASE_NAMESPACE ? [...namespaceRules(), ...clusterRules()] : clusterRules();
}

function missingVerbs(rules: Rule[], group: string, resource: string): string[] {
  const granted = rules
    .filter((rule) => rule.apiGroups?.includes(group) && rule.resources?.includes(resource))
    .flatMap((rule) => rule.verbs ?? []);
  if (granted.includes("*")) return [];
  return MANAGE_VERBS.filter((verb) => !granted.includes(verb));
}

describe.each(Object.entries(RENDERS))("the operator chart rendered with %s", (name, args) => {
  test("renders the kind its flag turns on", () => {
    expect(renderedKinds(args).map(({ kind }) => kind)).toContain(EXPECTED_KIND[name]);
  });

  test("renders only objects the operator may manage where they land", () => {
    for (const { group, kind, namespace } of renderedObjects(args)) {
      const resource = plural(kind);
      expect({ group, resource, namespace, missing: missingVerbs(rulesFor(namespace), group, resource) }).toEqual({
        group,
        resource,
        namespace,
        missing: [],
      });
    }
  });
});

test("route.main.enabled renders an HTTPRoute, so the route render above checks the Gateway API rule", () => {
  expect(renderedKinds(RENDERS["route.main.enabled"])).toContainEqual({
    group: "gateway.networking.k8s.io",
    kind: "HTTPRoute",
  });
});

test("the openshift render holds a Route, a ConsoleLink and a discovery Role elsewhere, so the check above covers each", () => {
  const objects = renderedObjects(RENDERS["authProvider=openshift under the operator"]);
  expect(objects).toContainEqual({ group: "route.openshift.io", kind: "Route", namespace: RELEASE_NAMESPACE });
  expect(objects).toContainEqual({ group: "console.openshift.io", kind: "ConsoleLink", namespace: null });
  expect(objects).toContainEqual({ group: "rbac.authorization.k8s.io", kind: "Role", namespace: "team-a" });
});

test("an object in another namespace or of a cluster-scoped kind needs the ClusterRole alone", () => {
  expect(rulesFor("team-a")).toEqual(clusterRules());
  expect(rulesFor(null)).toEqual(clusterRules());
  expect(missingVerbs(rulesFor("team-a"), "apps", "deployments")).toEqual(MANAGE_VERBS);
  expect(missingVerbs(rulesFor(RELEASE_NAMESPACE), "apps", "deployments")).toEqual([]);
});

test("the Gateway API rule grants httproutes only", () => {
  const gatewayResources = [...clusterRules(), ...namespaceRules()]
    .filter((rule) => (rule.apiGroups ?? []).some((group) => group === "gateway.networking.k8s.io"))
    .flatMap((rule) => rule.resources ?? []);
  expect(gatewayResources).toEqual(["httproutes"]);
});

describe("the bundle CSV", () => {
  const install = (
    parse(readFileSync(CSV, "utf8")) as {
      spec: {
        install: {
          spec: {
            clusterPermissions: Array<{ serviceAccountName: string; rules: Rule[] }>;
            permissions: Array<{ serviceAccountName: string; rules: Rule[] }>;
          };
        };
      };
    }
  ).spec.install.spec;

  test("grants the controller cluster-wide exactly the ClusterRole and the metrics auth role", () => {
    expect(install.clusterPermissions).toHaveLength(1);
    expect(install.clusterPermissions[0].rules).toEqual([...clusterRules(), ...rulesOf(METRICS_AUTH_ROLE)]);
  });

  test("grants the controller in its namespace exactly the leader election role and the Role", () => {
    expect(install.permissions).toHaveLength(1);
    expect(install.permissions[0].rules).toEqual([...rulesOf(LEADER_ELECTION_ROLE), ...namespaceRules()]);
  });

  test("grants both to the controller's ServiceAccount", () => {
    expect(install.clusterPermissions[0].serviceAccountName).toBe("libredb-studio-operator-controller-manager");
    expect(install.permissions[0].serviceAccountName).toBe("libredb-studio-operator-controller-manager");
  });
});
