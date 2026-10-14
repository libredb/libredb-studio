import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { KUBERNETES_PLANTED_NAMESPACES, KUBERNETES_SAMPLE_MARKERS } from "../../../helpers/kubernetes-markers";

/**
 * The throwaway clusters of docker/kubernetes/ are where the fixtures are captured and the live acceptance runs, so
 * what they must never do is held here: touch the default kubeconfig, listen beyond this machine, or call kubectl
 * without naming the cluster's own kubeconfig; and the sample data must plant every marker the tests look for.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string) => readFileSync(path.join(ROOT, "docker/kubernetes", file), "utf8");

interface Manifest {
  readonly kind?: string;
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
  readonly data?: Record<string, string>;
  readonly stringData?: Record<string, string>;
  readonly spec?: {
    readonly template?: { readonly spec?: { readonly containers?: { readonly env?: { value: string }[] }[] } };
    readonly tls?: { readonly hosts?: string[]; readonly secretName?: string }[];
  };
  readonly secrets?: { readonly name: string }[];
  readonly rules?: {
    readonly apiGroups?: string[];
    readonly resources?: string[];
    readonly resourceNames?: string[];
    readonly verbs?: string[];
  }[];
  readonly roleRef?: { readonly kind: string; readonly name: string };
  readonly subjects?: { readonly kind: string; readonly name: string; readonly namespace?: string }[];
}

const SAMPLE = parseAllDocuments(read("sample.yaml")).map((document) => document.toJS() as Manifest);

describe("create-cluster.sh", () => {
  const script = read("create-cluster.sh");

  test("never updates or switches the default kubeconfig, and binds the API server to 127.0.0.1", () => {
    expect(script).toContain("--kubeconfig-update-default=false --kubeconfig-switch-context=false");
    expect(script).toContain('--api-port "127.0.0.1:$PORT"');
  });

  test("refuses an existing cluster and a kubeconfig directory inside the repository", () => {
    expect(script).toContain('if k3d cluster get "$NAME" >/dev/null 2>&1; then');
    expect(script).toContain('"$REPO"/*) echo "K8S_ENV_DIR must be outside the repository');
  });
});

describe("seed.sh", () => {
  const script = read("seed.sh");

  test("every kubectl call goes through k(), which names the cluster's own kubeconfig, context and cache, no kuberc", () => {
    const calls = script.split("\n").filter((line) => !line.startsWith("#") && /(^|[\s;(])kubectl\b/.test(line));
    expect(calls).toEqual([
      'k() { KUBECTL_KUBERC=false kubectl --kubeconfig="$ADMIN" --context="k3d-$NAME" --cache-dir="$DIR/.kube-cache" "$@"; }',
    ]);
  });

  test("writes the five token personas, each into the namespace shop", () => {
    for (const persona of ["viewer", "shop-only", "reader", "studio-reader", "secret-reader"]) {
      expect(script).toContain(`persona ${persona} `);
    }
    expect(script).toContain("      namespace: shop");
    expect(script).toContain("--duration=72h");
  });
});

describe("the README names the clusters it documents", () => {
  const readme = read("README.md");

  test.each([
    ["k8s-probe", "mirror.gcr.io/rancher/k3s:v1.35.5-k3s1", "26443"],
    ["k8s-floor", "mirror.gcr.io/rancher/k3s:v1.30.14-k3s2", "26444"],
    ["k8s-best-effort", "mirror.gcr.io/rancher/k3s:v1.29.15-k3s1", "26445"],
  ])("%s on %s at port %s", (name, image, port) => {
    expect(readme).toContain(`docker/kubernetes/create-cluster.sh ${name} ${image} ${port}`);
  });
});

describe("the sample data plants every marker", () => {
  const find = (kind: string, name: string) =>
    SAMPLE.find((manifest) => manifest.kind === kind && manifest.metadata?.name === name);

  test("the Secret marker name and value, in both planted namespaces", () => {
    const named = find("Secret", KUBERNETES_SAMPLE_MARKERS.secretName);
    expect(named?.metadata?.namespace).toBe("shop");
    expect(named?.stringData?.[KUBERNETES_SAMPLE_MARKERS.secretKey]).toBe(KUBERNETES_SAMPLE_MARKERS.secretValue);
    expect(named?.metadata?.labels?.[KUBERNETES_SAMPLE_MARKERS.labelKey]).toBe(KUBERNETES_SAMPLE_MARKERS.labelValue);
    expect(named?.metadata?.annotations?.[KUBERNETES_SAMPLE_MARKERS.annotationKey]).toBe(
      KUBERNETES_SAMPLE_MARKERS.annotationValue,
    );
    const restricted = find("Secret", "top-secret");
    expect(restricted?.metadata?.namespace).toBe("restricted");
    expect(restricted?.stringData?.[KUBERNETES_SAMPLE_MARKERS.secretKey]).toBe(KUBERNETES_SAMPLE_MARKERS.secretValue);
    const secretNamespaces = SAMPLE.filter((manifest) => manifest.kind === "Secret").map(
      (manifest) => manifest.metadata?.namespace,
    );
    expect([...new Set(secretNamespaces)].sort()).toEqual([...KUBERNETES_PLANTED_NAMESPACES].sort());
  });

  test("the ConfigMap key and value, the env value, the label and the annotation, keys and values", () => {
    expect(find("ConfigMap", "shop-config")?.data?.[KUBERNETES_SAMPLE_MARKERS.configMapKey]).toBe(
      KUBERNETES_SAMPLE_MARKERS.configMapValue,
    );
    const web = find("Deployment", "web");
    expect(web?.metadata?.labels?.[KUBERNETES_SAMPLE_MARKERS.labelKey]).toBe(KUBERNETES_SAMPLE_MARKERS.labelValue);
    expect(web?.metadata?.annotations?.[KUBERNETES_SAMPLE_MARKERS.annotationKey]).toBe(
      KUBERNETES_SAMPLE_MARKERS.annotationValue,
    );
    expect(web?.spec?.template?.spec?.containers?.[0]?.env?.[0]?.value).toBe(KUBERNETES_SAMPLE_MARKERS.envValue);
  });
});

describe("the sample data plants every machine-redaction rule", () => {
  const find = (kind: string, name: string, namespace?: string) =>
    SAMPLE.find(
      (manifest) =>
        manifest.kind === kind &&
        manifest.metadata?.name === name &&
        (namespace === undefined || manifest.metadata?.namespace === namespace),
    );
  const client = () => find("Deployment", "vault-client");

  test("a Deployment referencing the marker Secret in every form, with an args credential and a probe header", () => {
    const text = JSON.stringify(client());
    for (const field of ["secretKeyRef", "envFrom", "secretName", "projected", "imagePullSecrets", "httpHeaders"])
      expect(text).toContain(field);
    expect(text).toContain(KUBERNETES_SAMPLE_MARKERS.argsValue);
    expect(text).toContain(KUBERNETES_SAMPLE_MARKERS.headerValue);
    expect(text).toContain(KUBERNETES_SAMPLE_MARKERS.secretName);
  });

  test("an Ingress tls secretName, a ServiceAccount's secrets and a Role scoped to the Secret by name", () => {
    expect(find("Ingress", "web", "shop")?.spec?.tls).toEqual([
      { hosts: ["web.shop.example"], secretName: KUBERNETES_SAMPLE_MARKERS.secretName },
    ]);
    expect(find("ServiceAccount", "vault-client", "shop")?.secrets).toEqual([
      { name: KUBERNETES_SAMPLE_MARKERS.secretName },
    ]);
    expect(find("Role", "marker-secret-reader", "shop")?.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: [KUBERNETES_SAMPLE_MARKERS.secretName],
        verbs: ["get"],
      },
    ]);
  });

  test("the secret-reader persona may list and get Secrets in shop, and joins view and studio-reader", () => {
    const subject = { kind: "ServiceAccount", name: "secret-reader", namespace: "probe-auth" };
    expect(find("ServiceAccount", "secret-reader", "probe-auth")).toBeDefined();
    expect(find("Role", "secret-reader", "shop")?.rules).toEqual([
      { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] },
    ]);
    const binding = find("RoleBinding", "secret-reader", "shop");
    expect(binding?.roleRef).toMatchObject({ kind: "Role", name: "secret-reader" });
    expect(binding?.subjects).toEqual([subject]);
    for (const [name, role] of [
      ["secret-reader-view", "view"],
      ["secret-reader-studio", "studio-reader"],
    ]) {
      const clusterBinding = find("ClusterRoleBinding", name);
      expect(clusterBinding?.roleRef).toMatchObject({ kind: "ClusterRole", name: role });
      expect(clusterBinding?.subjects).toEqual([subject]);
    }
  });

  test("seed.sh writes five token personas", () => {
    expect(read("seed.sh")).toContain("persona secret-reader probe-auth secret-reader");
  });
});
