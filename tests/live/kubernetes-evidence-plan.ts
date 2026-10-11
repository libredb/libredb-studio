/**
 * What tests/live/kubernetes-evidence.ts asks each throwaway cluster of docker/kubernetes/, persona by persona, and
 * what each answer must show for the capture to be written. Pure data: the unit test checks the plan against the
 * console's own command table, so every v1 command is captured at least once for the reader persona, which the
 * end-to-end stub server replays.
 */

/** The fixture sets: the current release, the documented floor, and a best-effort version. */
export type EvidenceSet = "v1.35.5" | "v1.30.14" | "v1.29.15";
export type EvidencePersona = "admin" | "viewer" | "shop-only" | "reader" | "studio-reader";

export type EvidenceStep =
  | { readonly op: "connect"; readonly warns?: readonly string[] }
  | { readonly op: "containers"; readonly first: readonly string[] }
  | { readonly op: "count"; readonly container: string; readonly unavailable?: readonly string[] }
  | {
      readonly op: "list";
      readonly container: string;
      readonly kind: string;
      readonly holds?: string;
      readonly refused?: true;
    }
  | {
      readonly op: "source";
      readonly container: string;
      readonly name: string;
      readonly kind: string;
      readonly refused?: true;
    }
  /** Every kind of the container: its count, its listing, its bulk description, and its first object's description and source. */
  | { readonly op: "walk"; readonly container: string }
  | { readonly op: "health" }
  | { readonly op: "overview" }
  /** `shows` is what the grid of a statement that is not refused must hold; the unit test requires it. */
  | { readonly op: "statement"; readonly text: string; readonly refused?: true; readonly shows?: GridFact };

/** A fact of the sample data a grid must show: a cell whose text is exactly `cell`, or one whose text holds `within`. */
export type GridFact = { readonly cell: string } | { readonly within: string };

export interface EvidenceScenario {
  readonly persona: EvidencePersona;
  readonly steps: readonly EvidenceStep[];
}

export interface EvidenceTarget {
  /** The k3d cluster, as docker/kubernetes/README.md names it. */
  readonly cluster: string;
  /** The image the cluster runs, recorded in the manifest. */
  readonly image: string;
  /** What `/version` must answer as `gitVersion`'s prefix. */
  readonly gitVersion: string;
  readonly scenarios: readonly EvidenceScenario[];
}

/**
 * One statement of every v1 command, each as the reader persona runs it in the namespace shop, and the two statements
 * the tree's Describe and Logs row actions write for the pod `crasher`, whose name the sample data fixes.
 */
export const READER_STATEMENTS: readonly string[] = Object.freeze([
  "kubectl get pods -n shop",
  "kubectl get pods -n shop -o wide",
  "kubectl get deployments -A",
  "kubectl get secrets -n shop --show-labels",
  "kubectl get secret k8s-marker-secret-name -n shop -o yaml",
  "kubectl get configmap shop-config -n shop -o json",
  "kubectl get pods -n shop -o name",
  "kubectl get widgets -n shop",
  "kubectl get pods -n shop -w --request-timeout=2s",
  "kubectl describe deployment/web -n shop",
  "kubectl describe secret k8s-marker-secret-name -n shop",
  "kubectl describe clusterrole system:aggregate-to-view",
  "kubectl describe pod/crasher -n shop",
  "kubectl logs pod/crasher -n shop --tail=500",
  "kubectl logs deploy/logger -n shop -c sidecar --tail=20",
  "kubectl logs job/migrate -n shop",
  "kubectl logs pod/crasher -n shop -p --tail=5",
  "kubectl top pod -n shop",
  "kubectl top node",
  "kubectl events -n shop --types=Warning",
  "kubectl api-resources",
  "kubectl api-versions",
  "kubectl explain deployment.spec.replicas",
  "kubectl auth can-i list secrets -n shop",
  "kubectl auth can-i --list -n shop",
  "kubectl auth whoami",
  "kubectl version",
]);

/**
 * What each reader statement's grid must show, a fact of docker/kubernetes/sample.yaml or of the cluster the set names,
 * never a value read back from a capture. A `cell` fact is a whole cell (an object's name in the NAME column); a
 * `within` fact is a part of one. Each sits in the first rows a grid draws, so the browser sees it without scrolling.
 */
export const READER_STATEMENT_FACTS: Readonly<Record<string, GridFact>> = Object.freeze({
  "kubectl get pods -n shop": { cell: "crasher" },
  "kubectl get pods -n shop -o wide": { cell: "crasher" },
  "kubectl get deployments -A": { cell: "logger" },
  "kubectl get secrets -n shop --show-labels": { cell: "k8s-marker-secret-name" },
  "kubectl get secret k8s-marker-secret-name -n shop -o yaml": { within: "Opaque" },
  "kubectl get configmap shop-config -n shop -o json": { within: "FEATURE_FLAGS" },
  "kubectl get pods -n shop -o name": { cell: "pod/crasher" },
  "kubectl get widgets -n shop": { cell: "widget-a" },
  "kubectl get pods -n shop -w --request-timeout=2s": { cell: "crasher" },
  "kubectl describe deployment/web -n shop": { within: "Up-to-date" },
  "kubectl describe secret k8s-marker-secret-name -n shop": { within: "Opaque" },
  "kubectl describe clusterrole system:aggregate-to-view": { within: "kubernetes.io/bootstrapping" },
  "kubectl describe pod/crasher -n shop": { within: "Summary" },
  "kubectl logs pod/crasher -n shop --tail=500": { within: "starting crasher" },
  "kubectl logs deploy/logger -n shop -c sidecar --tail=20": { within: "sidecar tick" },
  "kubectl logs job/migrate -n shop": { within: "migrated 42 tables" },
  "kubectl logs pod/crasher -n shop -p --tail=5": { within: "starting crasher" },
  "kubectl top pod -n shop": { within: "logger" },
  "kubectl top node": { cell: "k3d-k8s-probe-server-0" },
  "kubectl events -n shop --types=Warning": { within: "BackOff" },
  "kubectl api-resources": { cell: "bindings" },
  "kubectl api-versions": { cell: "apps/v1" },
  "kubectl explain deployment.spec.replicas": { within: "integer" },
  "kubectl auth can-i list secrets -n shop": { cell: "yes" },
  "kubectl auth can-i --list -n shop": { within: "selfsubjectaccessreviews" },
  "kubectl auth whoami": { cell: "system:serviceaccount:probe-auth:reader" },
  "kubectl version": { within: "v1.35.5" },
});

/** Whether one row of a grid holds the fact, each cell read as text (an object cell as its JSON). */
export function gridShows(rows: readonly Record<string, unknown>[], fact: GridFact): boolean {
  return rows.some((row) =>
    Object.values(row).some((value) => {
      const text =
        typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
      return "cell" in fact ? text === fact.cell : text.includes(fact.within);
    }),
  );
}

export const EVIDENCE_TARGETS: Readonly<Record<EvidenceSet, EvidenceTarget>> = Object.freeze({
  "v1.35.5": {
    cluster: "k8s-probe",
    image: "mirror.gcr.io/rancher/k3s:v1.35.5-k3s1",
    gitVersion: "v1.35.5",
    scenarios: [
      {
        persona: "admin",
        steps: [
          { op: "connect", warns: ["do anything to every resource (* on *)"] },
          { op: "containers", first: ["Cluster"] },
          { op: "count", container: "Cluster" },
          { op: "list", container: "Cluster", kind: "nodes" },
          { op: "list", container: "Cluster", kind: "namespaces", holds: "namespace/shop" },
          { op: "health" },
          { op: "overview" },
        ],
      },
      {
        persona: "reader",
        steps: [
          { op: "connect", warns: ["read every Secret value in the cluster (list secrets)"] },
          { op: "containers", first: ["Cluster"] },
          { op: "health" },
          { op: "overview" },
          { op: "walk", container: "shop" },
          { op: "walk", container: "Cluster" },
          { op: "list", container: "shop", kind: "deployments", holds: "deployment/web" },
          { op: "list", container: "shop", kind: "secrets", holds: "secret/k8s-marker-secret-name" },
          { op: "list", container: "shop", kind: "customresources", holds: "widgets.probe.libredb.dev" },
          { op: "source", container: "shop", name: "deployment/web", kind: "deployments" },
          { op: "source", container: "shop", name: "secret/k8s-marker-secret-name", kind: "secrets" },
          { op: "source", container: "shop", name: "configmap/shop-config", kind: "configmaps" },
          { op: "source", container: "shop", name: "pod/does-not-exist", kind: "pods", refused: true },
          ...READER_STATEMENTS.map(
            (text): EvidenceStep => ({ op: "statement", text, shows: READER_STATEMENT_FACTS[text] }),
          ),
        ],
      },
      {
        persona: "viewer",
        steps: [
          { op: "connect" },
          { op: "containers", first: ["Cluster"] },
          { op: "health" },
          { op: "overview" },
          { op: "count", container: "shop", unavailable: ["secrets"] },
          { op: "count", container: "Cluster", unavailable: ["nodes", "clusterroles"] },
          { op: "list", container: "shop", kind: "pods" },
          { op: "list", container: "shop", kind: "secrets", refused: true },
          { op: "source", container: "shop", name: "deployment/web", kind: "deployments" },
          { op: "statement", text: "kubectl get pods -n shop", shows: { cell: "crasher" } },
          { op: "statement", text: "kubectl describe deployment/web -n shop", shows: { within: "Up-to-date" } },
          { op: "statement", text: "kubectl get secrets -n shop", refused: true },
        ],
      },
      {
        persona: "shop-only",
        steps: [
          { op: "connect", warns: ["may not list namespaces"] },
          { op: "containers", first: ["Cluster", "shop"] },
          { op: "count", container: "shop", unavailable: ["secrets"] },
          { op: "list", container: "shop", kind: "pods" },
          { op: "statement", text: "kubectl get pods", shows: { cell: "crasher" } },
          { op: "statement", text: "kubectl get pods -n analytics", refused: true },
        ],
      },
      {
        persona: "studio-reader",
        steps: [
          { op: "connect" },
          { op: "count", container: "Cluster", unavailable: ["clusterroles"] },
          { op: "list", container: "Cluster", kind: "nodes" },
          { op: "count", container: "shop", unavailable: ["secrets"] },
        ],
      },
    ],
  },
  "v1.30.14": {
    cluster: "k8s-floor",
    image: "mirror.gcr.io/rancher/k3s:v1.30.14-k3s2",
    gitVersion: "v1.30.14",
    scenarios: [
      {
        persona: "reader",
        steps: [
          { op: "connect" },
          { op: "containers", first: ["Cluster"] },
          { op: "list", container: "shop", kind: "pods" },
          { op: "statement", text: "kubectl get pods -n shop", shows: { cell: "crasher" } },
          { op: "statement", text: "kubectl version", shows: { within: "v1.30.14" } },
        ],
      },
    ],
  },
  "v1.29.15": {
    cluster: "k8s-best-effort",
    image: "mirror.gcr.io/rancher/k3s:v1.29.15-k3s1",
    gitVersion: "v1.29.15",
    scenarios: [
      {
        persona: "reader",
        steps: [
          { op: "connect" },
          { op: "containers", first: ["Cluster"] },
          { op: "list", container: "shop", kind: "pods" },
          { op: "health" },
          { op: "statement", text: "kubectl get pods -n shop", shows: { cell: "crasher" } },
        ],
      },
    ],
  },
});
