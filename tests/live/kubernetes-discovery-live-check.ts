/**
 * Opt-in live check of the Kubernetes discovery exporter and source against a real cluster with CloudNativePG
 * (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)").
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/helpers/kubernetes-discovery/fake-api.ts answers the way
 * the exporter's tests say a kube-apiserver does. Only a real one shows that the RBAC the docs give the exporter is
 * enough and no more, that CloudNativePG's own `<name>-app` Secrets pass the ownership rule, that the update keeps
 * the Secret's metadata, that a namespace without the exporter's Role answers 403, and how long the kubelet takes to
 * show the export in a pod.
 *
 * With the kubeconfig in LIBREDB_LIVE_KUBECONFIG, which must be allowed to create namespaces, Roles and RoleBindings,
 * the kinds to discover in LIBREDB_LIVE_KINDS (default `cnpg`; any of cnpg, edbpg, pgo, mongo, which get the chart's
 * Role rules: list on each kind, get on Secrets and on Services), and the namespaces of existing resources of those
 * kinds in LIBREDB_LIVE_NAMESPACES (default `team-a,team-b`), the
 * script creates a throwaway namespace libredb-kd-live-<random> with the exporter's ServiceAccount, the export
 * Secret (with a Helm-style label and annotation) and the Role that may get and update it, and a Role and RoleBinding
 * of the same name in each discovered namespace. It mints a short-lived token with the TokenRequest API, takes the
 * API URL and CA from the kubeconfig, and runs `node docker/discover-kubernetes.mjs` once against the discovered
 * namespaces plus the throwaway one, where the exporter has no list right. It then reads the export back and runs
 * Studio's own parser and mapping on it.
 *
 * With LIBREDB_LIVE_KUBELET_DELAY_SAMPLES=<n> it also starts a busybox pod that mounts the export Secret, runs the
 * exporter <n> more times, and prints how long each export took to show in the pod's file (the image must be on the
 * node: LIBREDB_LIVE_BUSYBOX_IMAGE, default docker.io/rancher/mirrored-library-busybox:1.37.0, a k3s system image).
 *
 * It prints one line per check, `ok   <check>` or `FAIL <check>` with the reason, never a Secret value, exits non-zero
 * when any check failed, and deletes everything it created either way.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_KUBECONFIG=/path/to/kubeconfig bun tests/live/kubernetes-discovery-live-check.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KUBERNETES_CONTRACT, mapKubernetesDatabase } from "../../src/lib/seed/kubernetes-discovery-contract";
import { parseKubernetesDiscoveryExport } from "../../src/lib/seed/kubernetes-discovery-export";

const kubeconfig = process.env.LIBREDB_LIVE_KUBECONFIG;
if (!kubeconfig) {
  console.error("Set LIBREDB_LIVE_KUBECONFIG to the kubeconfig of a disposable cluster or a lab.");
  process.exit(2);
}

const NAME = `libredb-kd-live-${randomBytes(4).toString("hex")}`;
const NAMESPACE = NAME;
const SERVICE_ACCOUNT = "discovery";
const EXPORT_SECRET = "discovery-export";
const DISCOVERED = (process.env.LIBREDB_LIVE_NAMESPACES ?? "team-a,team-b").split(",").map((item) => item.trim());
/** The kinds to discover, as KUBERNETES_DISCOVERY_KINDS takes them: cnpg alone by default, as the exporter's default. */
const KINDS = (process.env.LIBREDB_LIVE_KINDS ?? "cnpg")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item !== "");
const SAMPLES = Number(process.env.LIBREDB_LIVE_KUBELET_DELAY_SAMPLES ?? "0");
const BUSYBOX = process.env.LIBREDB_LIVE_BUSYBOX_IMAGE ?? "docker.io/rancher/mirrored-library-busybox:1.37.0";
const EXPORTER = path.join(import.meta.dir, "..", "..", "docker", "discover-kubernetes.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "libredb-kd-live-"));
let failures = 0;

function kubectl(args: readonly string[], input?: string): string {
  return execFileSync("kubectl", ["--kubeconfig", kubeconfig as string, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function check(name: string, passed: boolean, why = ""): void {
  if (!passed) failures += 1;
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${passed || why === "" ? "" : `: ${why}`}`);
}

function apply(manifest: unknown): void {
  kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
}

function role(namespace: string, rules: unknown[]): void {
  apply({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: NAME, namespace }, rules });
  apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: NAME, namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: NAME },
    subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT, namespace: NAMESPACE }],
  });
}

function exportText(): string {
  const encoded = kubectl(["get", "secret", EXPORT_SECRET, "-n", NAMESPACE, "-o", "jsonpath={.data.export\\.json}"]);
  return Buffer.from(encoded, "base64").toString("utf8");
}

function runExporter(env: Record<string, string>): { status: number | null; log: string } {
  const run = spawnSync("node", [EXPORTER], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { status: run.status, log: `${run.stdout}${run.stderr}` };
}

function setUp(): Record<string, string> {
  apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } });
  apply({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE } });
  apply({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: EXPORT_SECRET,
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/managed-by": "Helm" },
      annotations: { "meta.helm.sh/release-name": "libredb-studio" },
    },
  });
  role(NAMESPACE, [
    { apiGroups: [""], resources: ["secrets"], resourceNames: [EXPORT_SECRET], verbs: ["get", "update"] },
  ]);
  // The chart's rules: list on each discovered kind, get on Secrets and on Services, nothing else.
  for (const namespace of DISCOVERED) {
    role(namespace, [
      ...KUBERNETES_CONTRACT.filter((row) => KINDS.includes(row.slug)).map((row) => ({
        apiGroups: [row.group],
        resources: [row.plural],
        verbs: ["list"],
      })),
      { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
      { apiGroups: [""], resources: ["services"], verbs: ["get"] },
    ]);
  }
  const token = kubectl(["create", "token", SERVICE_ACCOUNT, "-n", NAMESPACE, "--duration=600s"]).trim();
  const server = kubectl(["config", "view", "--minify", "--raw", "-o", "jsonpath={.clusters[0].cluster.server}"]);
  const caData = kubectl([
    "config",
    "view",
    "--minify",
    "--raw",
    "-o",
    "jsonpath={.clusters[0].cluster.certificate-authority-data}",
  ]);
  writeFileSync(path.join(dir, "token"), token, { mode: 0o600 });
  writeFileSync(path.join(dir, "ca.crt"), Buffer.from(caData, "base64"));
  return {
    KUBERNETES_DISCOVERY_API_URL: server,
    KUBERNETES_DISCOVERY_TOKEN_PATH: path.join(dir, "token"),
    KUBERNETES_DISCOVERY_CA_PATH: path.join(dir, "ca.crt"),
    KUBERNETES_DISCOVERY_NAMESPACES: [...DISCOVERED, NAMESPACE].join(","),
    KUBERNETES_DISCOVERY_EXPORT_SECRET: `${NAMESPACE}/${EXPORT_SECRET}`,
    KUBERNETES_DISCOVERY_KINDS: KINDS.join(","),
    KUBERNETES_DISCOVERY_ONCE: "1",
  };
}

function checkExport(env: Record<string, string>): void {
  const before = kubectl([
    "get",
    "secret",
    EXPORT_SECRET,
    "-n",
    NAMESPACE,
    "-o",
    "jsonpath={.metadata.resourceVersion}",
  ]);
  const run = runExporter(env);
  check("the exporter scans once and exits 0", run.status === 0, run.log.trim());
  const text = exportText();
  const parsed = parseKubernetesDiscoveryExport(text);
  check("Studio's parser accepts the export", parsed.ok, parsed.ok ? "" : parsed.reason);
  if (!parsed.ok) return;
  const { value } = parsed;
  check("the scan succeeded", value.status.ok && value.generatedAt !== null, JSON.stringify(value.status));
  for (const namespace of DISCOVERED) {
    const status = value.namespaces.find((entry) => entry.name === namespace)?.status;
    check(`namespace ${namespace} was read`, status?.ok === true, JSON.stringify(status));
  }
  const own = value.namespaces.find((entry) => entry.name === NAMESPACE)?.status;
  check(
    "a namespace without the exporter's Role answers forbidden, and the others are still exported",
    own?.ok === false && own.code === "forbidden",
    JSON.stringify(own),
  );
  check(
    "at least one database per discovered namespace",
    DISCOVERED.every((ns) => value.databases.some((db) => db.resource.metadata.namespace === ns)),
  );
  for (const database of value.databases) {
    const mapped = mapKubernetesDatabase(database);
    const label = `${database.kind} ${mapped.key}`;
    check(
      `${label}: the operator's own Service and Secret pass every exporter check and map to a connection`,
      mapped.ok,
      mapped.ok ? "" : mapped.reason,
    );
    if (mapped.ok) {
      console.log(
        `     ${label} -> ${mapped.connection.id} ${mapped.connection.host}:${mapped.connection.port}/${mapped.connection.database} as ${mapped.connection.user}, Secret ${mapped.secret.name}`,
      );
    }
  }
  check(
    "no Secret value reaches the exporter's log",
    value.databases.every((db) => {
      const password = db.secret.data?.password;
      return password === undefined || !run.log.includes(password);
    }),
  );
  const metadata = JSON.parse(kubectl(["get", "secret", EXPORT_SECRET, "-n", NAMESPACE, "-o", "json"])).metadata;
  check(
    "the update kept the export Secret's label and annotation and moved its resourceVersion",
    metadata.labels?.["app.kubernetes.io/managed-by"] === "Helm" &&
      metadata.annotations?.["meta.helm.sh/release-name"] === "libredb-studio" &&
      metadata.resourceVersion !== before,
  );
}

async function measureKubeletDelay(env: Record<string, string>): Promise<void> {
  apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "kubelet-delay", namespace: NAMESPACE },
    spec: {
      containers: [
        {
          name: "kubelet-delay",
          image: BUSYBOX,
          imagePullPolicy: "IfNotPresent",
          command: ["sleep", "3600"],
          volumeMounts: [{ name: "export", mountPath: "/export", readOnly: true }],
        },
      ],
      volumes: [{ name: "export", secret: { secretName: EXPORT_SECRET } }],
    },
  });
  kubectl(["wait", "--for=condition=Ready", "pod/kubelet-delay", "-n", NAMESPACE, "--timeout=120s"]);
  const delays: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    // oxlint-disable-next-line no-await-in-loop -- samples are taken one after another, as the kubelet syncs.
    await new Promise((resolve) => setTimeout(resolve, 5000 + Math.floor(Math.random() * 10000)));
    const run = runExporter(env);
    const written = Date.now();
    if (run.status !== 0) {
      check(`kubelet delay sample ${sample + 1}: the exporter wrote`, false, run.log.trim());
      continue;
    }
    const checkedAt = JSON.parse(exportText()).checkedAt as string;
    let seen = 0;
    while (seen === 0 && Date.now() - written < 180_000) {
      const inPod = spawnSync(
        "kubectl",
        [
          "--kubeconfig",
          kubeconfig as string,
          "exec",
          "-n",
          NAMESPACE,
          "kubelet-delay",
          "--",
          "cat",
          "/export/export.json",
        ],
        { encoding: "utf8" },
      );
      if (inPod.stdout.includes(`"checkedAt":"${checkedAt}"`)) seen = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- polling the pod's file.
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const delay = seen === 0 ? Number.NaN : (seen - written) / 1000;
    delays.push(delay);
    console.log(`     kubelet delay sample ${sample + 1}: the pod showed the export after ${delay.toFixed(1)} s`);
  }
  const shown = delays.filter((delay) => Number.isFinite(delay)).sort((a, b) => a - b);
  check(
    `kubelet delay: every export reached the pod within 180 s (${shown.length}/${SAMPLES})`,
    shown.length === SAMPLES,
  );
  if (shown.length > 0) {
    const median = shown[Math.floor((shown.length - 1) / 2)];
    console.log(
      `     kubelet delay summary: min ${shown[0].toFixed(1)} s, median ${median.toFixed(1)} s, max ${shown.at(-1)?.toFixed(1)} s`,
    );
  }
}

function tearDown(): void {
  for (const namespace of DISCOVERED) {
    spawnSync("kubectl", [
      "--kubeconfig",
      kubeconfig as string,
      "delete",
      "rolebinding,role",
      NAME,
      "-n",
      namespace,
      "--ignore-not-found",
    ]);
  }
  spawnSync("kubectl", [
    "--kubeconfig",
    kubeconfig as string,
    "delete",
    "namespace",
    NAMESPACE,
    "--ignore-not-found",
    "--wait=false",
  ]);
  rmSync(dir, { recursive: true, force: true });
}

try {
  const env = setUp();
  checkExport(env);
  if (SAMPLES > 0) await measureKubeletDelay(env);
} catch (error) {
  check("the live check ran to its end", false, (error as Error).message.split("\n")[0]);
} finally {
  tearDown();
  console.log(`${NAME} removed`);
}
process.exit(failures === 0 ? 0 : 1);
