// @requires helm
/**
 * The chart's Kubernetes discovery values (discovery.kubernetes), the second half of Rancher mode.
 *
 * Enabled, the chart runs docker/discover-kubernetes.mjs as a Deployment of its own, from Studio's image and with a
 * ServiceAccount of its own, gives that account exactly the rights docs/SEED_CONNECTIONS.md lists (list on
 * CloudNativePG Clusters and get on Secrets in each discovered namespace, get and update on the export Secret by
 * name), creates the export Secret empty, because the exporter never creates it, and mounts that Secret read-only into
 * Studio's pod for SEED_KUBERNETES_DISCOVERY_PATH. Off, none of it renders.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { KUBERNETES_CONTRACT } from "@/lib/seed/kubernetes-discovery-contract";
import { DEFAULTS } from "../../docker/discover-kubernetes.mjs";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "libredb-studio";
const NAMESPACE = "libredb-studio";
const EXPORT_SECRET = "libredb-studio-discovery-export";
const EXPORT_PATH = "/var/run/libredb/kubernetes-discovery/export.json";

interface EnvVar {
  name: string;
  value?: string;
}

interface Container {
  name: string;
  image: string;
  command?: string[];
  env?: EnvVar[];
  resources?: Record<string, unknown>;
  securityContext?: Record<string, unknown>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
}

interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: Record<string, unknown>;
  containers: Container[];
  volumes?: Array<{ name: string; secret?: { secretName: string; optional?: boolean; items?: unknown } }>;
}

interface Manifest {
  apiVersion: string;
  kind: string;
  type?: string;
  data?: Record<string, string>;
  automountServiceAccountToken?: boolean;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  rules?: Array<{ apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }>;
  roleRef?: { apiGroup: string; kind: string; name: string };
  subjects?: Array<{ kind: string; name: string; namespace: string }>;
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string>; [key: string]: unknown };
    podSelector?: { matchLabels?: Record<string, string> };
    template?: { metadata: { labels: Record<string, string> }; spec: PodSpec };
  };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", NAMESPACE, ...args], {
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
  const run = template(args);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
}

function one(docs: Manifest[], kind: string, name: string): Manifest {
  const found = docs.filter((doc) => doc.kind === kind && doc.metadata.name === name);
  expect(found).toHaveLength(1);
  return found[0];
}

function studio(docs: Manifest[]): Manifest {
  return one(docs, "Deployment", "libredb-studio");
}

function exporter(docs: Manifest[]): Manifest {
  return one(docs, "Deployment", "libredb-studio-discovery");
}

function podOf(deployment: Manifest): PodSpec {
  const spec = deployment.spec?.template?.spec;
  if (!spec) throw new Error(`no pod spec in ${deployment.metadata.name}`);
  return spec;
}

function envOf(deployment: Manifest): Record<string, string | undefined> {
  return Object.fromEntries((podOf(deployment).containers[0].env ?? []).map((entry) => [entry.name, entry.value]));
}

const ON = ["--set", "discovery.kubernetes.enabled=true", "--set", "discovery.kubernetes.namespaces={team-a,team-b}"];

/** The Role and RoleBinding in each discovered namespace carry the release namespace, as two releases may discover one namespace. */
const NAMESPACED_ROLE = `${NAMESPACE}.libredb-studio-discovery`;

describe("discovery.kubernetes is off by default", () => {
  test("the default install renders no exporter, RBAC, export Secret, mount or variable", () => {
    const docs = render([]);
    expect(docs.some((doc) => doc.metadata.name.includes("discovery"))).toBe(false);
    expect(docs.some((doc) => ["Role", "RoleBinding"].includes(doc.kind))).toBe(false);
    const env = envOf(studio(docs));
    expect(Object.keys(env).some((name) => name.startsWith("SEED_KUBERNETES_"))).toBe(false);
    expect(env).not.toHaveProperty("SEED_CACHE_TTL_MS");
  });

  test("values.yaml carries the block with every key off or empty", async () => {
    const values = await Bun.file(join(CHART_DIR, "values.yaml")).text();
    expect(values).toMatch(
      /discovery:\n(?:\s*#.*\n)*\s+kubernetes:\n(?:[\s\S]*?)enabled: false[\s\S]*?namespaces: \[\][\s\S]*?intervalMs: 30000[\s\S]*?kinds: \[\][\s\S]*?maxAgeMs: null/,
    );
  });
});

describe("the exporter Deployment", () => {
  test("runs one replica of Studio's image with the exporter command and its own ServiceAccount", () => {
    const docs = render([...ON, "--set", "image.tag=9.9.9"]);
    const deployment = exporter(docs);
    expect(deployment.spec?.replicas).toBe(1);
    const pod = podOf(deployment);
    expect(pod.serviceAccountName).toBe("libredb-studio-discovery");
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.containers).toHaveLength(1);
    const [container] = pod.containers;
    expect(container.image).toBe("ghcr.io/libredb/libredb-studio:9.9.9");
    expect(container.command).toEqual(["node", "/usr/local/lib/libredb-studio/discover-kubernetes.mjs"]);
    const account = one(docs, "ServiceAccount", "libredb-studio-discovery");
    expect(account.automountServiceAccountToken).toBe(true);
  });

  test("keeps Studio's hardening: non-root, read-only root filesystem, no capability, no port", () => {
    const pod = podOf(exporter(render(ON)));
    expect(pod.securityContext?.runAsNonRoot).toBe(true);
    const [container] = pod.containers;
    expect(container.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext?.capabilities).toEqual({ drop: ["ALL"] });
    expect(container).not.toHaveProperty("ports");
  });

  test("writes the exporter's variables: namespaces, export Secret, interval", () => {
    const env = envOf(exporter(render(ON)));
    expect(env).toEqual({
      KUBERNETES_DISCOVERY_NAMESPACES: "team-a,team-b",
      KUBERNETES_DISCOVERY_EXPORT_SECRET: `${NAMESPACE}/${EXPORT_SECRET}`,
      KUBERNETES_DISCOVERY_INTERVAL_MS: "30000",
    });
  });

  test("kinds and the interval are written as set", () => {
    const env = envOf(
      exporter(
        render([...ON, "--set", "discovery.kubernetes.kinds={cnpg}", "--set", "discovery.kubernetes.intervalMs=60000"]),
      ),
    );
    expect(env.KUBERNETES_DISCOVERY_KINDS).toBe("cnpg");
    expect(env.KUBERNETES_DISCOVERY_INTERVAL_MS).toBe("60000");
  });

  test("its resources come from discovery.kubernetes.resources", () => {
    const [container] = podOf(
      exporter(render([...ON, "--set", "discovery.kubernetes.resources.limits.memory=128Mi"])),
    ).containers;
    expect(container.resources).toEqual({ limits: { memory: "128Mi" } });
  });

  test("its labels never match Studio's Service, so the Service never routes to it", () => {
    const docs = render(ON);
    const service = docs.find((doc) => doc.kind === "Service");
    const selector = (service?.spec?.selector ?? {}) as Record<string, string>;
    const labels = exporter(docs).spec?.template?.metadata.labels ?? {};
    expect(Object.entries(selector).every(([key, value]) => labels[key] === value)).toBe(false);
    expect(labels["app.kubernetes.io/component"]).toBe("discovery-exporter");
    expect(exporter(docs).spec?.selector?.matchLabels).toEqual({
      "app.kubernetes.io/name": "libredb-studio-discovery",
      "app.kubernetes.io/instance": RELEASE,
    });
  });
});

describe("the exporter's selector at a long name", () => {
  test("a 63-character nameOverride keeps the -discovery suffix, so no Studio selector matches the exporter", () => {
    const docs = render([...ON, "--set", `nameOverride=${"n".repeat(63)}`]);
    const exporterDeployment = docs.find(
      (doc) =>
        doc.kind === "Deployment" &&
        doc.spec?.template?.metadata.labels["app.kubernetes.io/component"] === "discovery-exporter",
    );
    const studioDeployment = docs.find((doc) => doc.kind === "Deployment" && doc !== exporterDeployment);
    const exporterName = exporterDeployment?.spec?.selector?.matchLabels?.["app.kubernetes.io/name"] ?? "";
    expect(exporterName.endsWith("-discovery")).toBe(true);
    expect(exporterName.length).toBeLessThanOrEqual(63);
    expect(exporterName).not.toBe(studioDeployment?.spec?.selector?.matchLabels?.["app.kubernetes.io/name"]);
    const service = docs.find((doc) => doc.kind === "Service");
    const selector = (service?.spec?.selector ?? {}) as Record<string, string>;
    const labels = exporterDeployment?.spec?.template?.metadata.labels ?? {};
    expect(Object.entries(selector).every(([key, value]) => labels[key] === value)).toBe(false);
  });
});

describe("the exporter's RBAC", () => {
  test("each discovered namespace gets a Role with list on clusters and get on secrets and services, bound to the exporter", () => {
    const docs = render(ON);
    for (const namespace of ["team-a", "team-b"]) {
      const role = docs.find(
        (doc) => doc.kind === "Role" && doc.metadata.name === NAMESPACED_ROLE && doc.metadata.namespace === namespace,
      );
      expect(role?.rules).toEqual([
        { apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: ["list"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
        { apiGroups: [""], resources: ["services"], verbs: ["get"] },
      ]);
      const binding = docs.find(
        (doc) =>
          doc.kind === "RoleBinding" && doc.metadata.name === NAMESPACED_ROLE && doc.metadata.namespace === namespace,
      );
      expect(binding?.roleRef).toEqual({
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: NAMESPACED_ROLE,
      });
      expect(binding?.subjects).toEqual([
        { kind: "ServiceAccount", name: "libredb-studio-discovery", namespace: NAMESPACE },
      ]);
    }
  });

  test("two releases of one name in two namespaces render distinct Roles in a namespace both discover", () => {
    const names = ["studio-prod", "studio-staging"].map((namespace) => {
      const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", namespace, ...ON], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(0);
      const docs = parseAllDocuments(run.stdout.toString())
        .map((doc) => doc.toJSON() as Manifest)
        .filter(Boolean);
      return docs
        .filter((doc) => (doc.kind === "Role" || doc.kind === "RoleBinding") && doc.metadata.namespace === "team-a")
        .map((doc) => `${doc.kind}/${doc.metadata.name}`);
    });
    expect(names[0]).toEqual([
      "Role/studio-prod.libredb-studio-discovery",
      "RoleBinding/studio-prod.libredb-studio-discovery",
    ]);
    expect(names[1]).toEqual([
      "Role/studio-staging.libredb-studio-discovery",
      "RoleBinding/studio-staging.libredb-studio-discovery",
    ]);
  });

  test("the release namespace gets get and update on the export Secret by name, and nothing else", () => {
    const docs = render(ON);
    const role = one(docs, "Role", "libredb-studio-discovery-export");
    expect(role.metadata.namespace ?? NAMESPACE).toBe(NAMESPACE);
    expect(role.rules).toEqual([
      { apiGroups: [""], resources: ["secrets"], resourceNames: [EXPORT_SECRET], verbs: ["get", "update"] },
    ]);
    const binding = one(docs, "RoleBinding", "libredb-studio-discovery-export");
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "libredb-studio-discovery", namespace: NAMESPACE },
    ]);
  });

  /**
   * The release namespace holds the release's Helm records, which are Secrets, so the export Secret by name must stay
   * the only Secret any rendered role lets anyone write, the release namespace discovered too and every kind on.
   */
  test("no rendered role writes a Secret but the export Role, on the export Secret by name", () => {
    const docs = render([
      "--set",
      "discovery.kubernetes.enabled=true",
      "--set",
      `discovery.kubernetes.namespaces={${NAMESPACE},team-a}`,
      "--set",
      "discovery.kubernetes.kinds={mongo,pgo,edbpg,cnpg}",
      "--set",
      "postgresql.enabled=true",
    ]);
    const writes = docs
      .filter((doc) => doc.kind === "Role" || doc.kind === "ClusterRole")
      .flatMap((role) =>
        (role.rules ?? [])
          .filter(
            (rule) =>
              rule.apiGroups.some((group) => group === "" || group === "*") &&
              rule.resources.some((resource) => resource === "secrets" || resource === "*") &&
              rule.verbs.some((verb) => verb !== "get"),
          )
          .map((rule) => ({
            role: `${role.kind}/${role.metadata.namespace ?? NAMESPACE}/${role.metadata.name}`,
            rule,
          })),
      );
    expect(writes).toEqual([
      {
        role: `Role/${NAMESPACE}/libredb-studio-discovery-export`,
        rule: { apiGroups: [""], resources: ["secrets"], resourceNames: [EXPORT_SECRET], verbs: ["get", "update"] },
      },
    ]);
  });

  test("no rule watches anything or lists Secrets or Services, and no ClusterRole is rendered for discovery", () => {
    const docs = render([...ON, "--set", "discovery.kubernetes.kinds={mongo,pgo,edbpg,cnpg}"]);
    for (const role of docs.filter((doc) => doc.kind === "Role")) {
      for (const rule of role.rules ?? []) {
        expect(rule.verbs).not.toContain("watch");
        if (rule.resources.includes("secrets") || rule.resources.includes("services")) {
          expect(rule.verbs).not.toContain("list");
        }
      }
    }
    expect(docs.some((doc) => doc.kind === "ClusterRole")).toBe(false);
  });

  /** The rules of the Role in team-a for the kinds `kinds` sets, or for the default when it is undefined. */
  function teamARules(kinds?: string) {
    const docs = render(kinds === undefined ? ON : [...ON, "--set", `discovery.kubernetes.kinds={${kinds}}`]);
    const role = docs.find(
      (doc) => doc.kind === "Role" && doc.metadata.name === NAMESPACED_ROLE && doc.metadata.namespace === "team-a",
    );
    return role?.rules ?? [];
  }

  const READS = [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
    { apiGroups: [""], resources: ["services"], verbs: ["get"] },
  ];

  test("per-kind list rules equal the contract's group and plural, in contract order, whatever order kinds names", () => {
    expect(teamARules("mongo,pgo,edbpg,cnpg")).toEqual([
      ...KUBERNETES_CONTRACT.map((row) => ({ apiGroups: [row.group], resources: [row.plural], verbs: ["list"] })),
      ...READS,
    ]);
    for (const row of KUBERNETES_CONTRACT) {
      expect(teamARules(row.slug)).toEqual([
        { apiGroups: [row.group], resources: [row.plural], verbs: ["list"] },
        ...READS,
      ]);
    }
  });

  test("the default rules are the exporter's default kinds", () => {
    expect(DEFAULTS.kinds).toEqual(["cnpg"]);
    expect(teamARules()).toEqual([
      ...KUBERNETES_CONTRACT.filter((row) => DEFAULTS.kinds.includes(row.slug)).map((row) => ({
        apiGroups: [row.group],
        resources: [row.plural],
        verbs: ["list"],
      })),
      ...READS,
    ]);
  });

  test("the schema's kinds are the contract's slugs, each at most once", async () => {
    const schema = await Bun.file(join(CHART_DIR, "values.schema.json")).json();
    const kinds = schema.properties.discovery.properties.kubernetes.properties.kinds;
    expect(kinds.items.enum).toEqual(KUBERNETES_CONTRACT.map((row) => row.slug));
    expect(kinds.uniqueItems).toBe(true);
    refused([...ON, "--set", "discovery.kubernetes.kinds={pgo,pgo}"], "kinds");
  });
});

describe("the export Secret", () => {
  test("is rendered with no data, so an upgrade never clears what the exporter wrote", () => {
    const secret = one(render(ON), "Secret", EXPORT_SECRET);
    expect(secret.metadata.namespace ?? NAMESPACE).toBe(NAMESPACE);
    expect(secret.type).toBe("Opaque");
    expect(secret).not.toHaveProperty("data");
    expect(secret).not.toHaveProperty("stringData");
  });
});

describe("Studio's side", () => {
  test("mounts the export Secret read-only and points SEED_KUBERNETES_DISCOVERY_PATH at export.json", () => {
    const deployment = studio(render(ON));
    const pod = podOf(deployment);
    const volume = pod.volumes?.find((entry) => entry.name === "kubernetes-discovery");
    expect(volume?.secret).toEqual({ secretName: EXPORT_SECRET });
    const mount = pod.containers[0].volumeMounts?.find((entry) => entry.name === "kubernetes-discovery");
    expect(mount).toEqual({
      name: "kubernetes-discovery",
      mountPath: "/var/run/libredb/kubernetes-discovery",
      readOnly: true,
    });
    const env = envOf(deployment);
    expect(env.SEED_KUBERNETES_DISCOVERY_PATH).toBe(EXPORT_PATH);
    expect(env).not.toHaveProperty("SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS");
  });

  test("writes SEED_CACHE_TTL_MS from seedConnections.cacheTTL with no seed file", () => {
    const env = envOf(studio(render([...ON, "--set", "seedConnections.cacheTTL=10000"])));
    expect(env.SEED_CACHE_TTL_MS).toBe("10000");
    expect(env).not.toHaveProperty("SEED_CONFIG_PATH");
  });

  test("maxAgeMs writes SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS", () => {
    const env = envOf(studio(render([...ON, "--set", "discovery.kubernetes.maxAgeMs=240000"])));
    expect(env.SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS).toBe("240000");
  });

  test("Studio's own pod still mounts no ServiceAccount token", () => {
    expect(podOf(studio(render(ON))).automountServiceAccountToken).toBe(false);
  });

  test("a fullnameOverride renames every object and the Secret both sides name", () => {
    const docs = render([...ON, "--set", "fullnameOverride=studio"]);
    one(docs, "Secret", "studio-discovery-export");
    const deployment = one(docs, "Deployment", "studio-discovery");
    expect(envOf(deployment).KUBERNETES_DISCOVERY_EXPORT_SECRET).toBe(`${NAMESPACE}/studio-discovery-export`);
    expect(one(docs, "Role", "studio-discovery-export").rules?.[0].resourceNames).toEqual(["studio-discovery-export"]);
  });
});

describe("discovery guards", () => {
  test("enabled with no namespace fails the render", () => {
    refused(["--set", "discovery.kubernetes.enabled=true"], "discovery.kubernetes.namespaces");
  });

  test("a namespace that is not a Kubernetes name is refused by the schema", () => {
    refused(
      ["--set", "discovery.kubernetes.enabled=true", "--set", "discovery.kubernetes.namespaces={Team_A}"],
      "namespaces",
    );
  });

  test("an unknown kind is refused by the schema", () => {
    refused([...ON, "--set", "discovery.kubernetes.kinds={mysql}"], "kinds");
  });

  test("an interval under five seconds is refused by the schema", () => {
    refused([...ON, "--set", "discovery.kubernetes.intervalMs=1000"], "intervalMs");
  });

  test("more than one replica fails the render", () => {
    refused(
      [...ON, "--set", "replicaCount=2", "--set", "secrets.jwtSecret=not-a-real-secret-0123456789abcdef"],
      "one replica",
    );
  });

  test("autoscaling fails the render", () => {
    refused(
      [...ON, "--set", "autoscaling.enabled=true", "--set", "secrets.jwtSecret=not-a-real-secret-0123456789abcdef"],
      "one replica",
    );
  });

  test("an extraEnv entry named SEED_KUBERNETES_DISCOVERY_* fails the render", () => {
    refused(
      [...ON, "--set", "extraEnv[0].name=SEED_KUBERNETES_DISCOVERY_PATH", "--set", "extraEnv[0].value=/tmp/x"],
      "SEED_KUBERNETES_DISCOVERY_PATH",
    );
  });
});
