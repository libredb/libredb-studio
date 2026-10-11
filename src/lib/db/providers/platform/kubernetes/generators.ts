/**
 * What a tree click, Generate Command and a declared row action write for a Kubernetes object, read through
 * `DIALECT_GENERATORS.kubectl` in `src/lib/query-generators.ts`.
 *
 * Pure, and shipped to the browser. Every statement uses the object's stored path segment, which already carries its
 * kind (`pod/web-6f7d`) or, for a Custom Resources row, names the type (`widgets.probe.libredb.dev`), so a kind prefix
 * is never doubled; `-n` names the container, and is left out under `Cluster`. Names need no quoting: a namespace is a
 * DNS-1123 label, and a stored segment holds only the characters the request policy admits, because the listing refuses
 * a folder holding any other name (`isRequestableName`).
 */
import { CLUSTER_CONTAINER } from "./kinds";
import { KUBERNETES_LOG_ROW_TAIL } from "./limits";

/** The namespace flag of a path's container: ` -n shop`, or nothing under Cluster. */
function namespaceFlag(path: readonly string[]): string {
  const container = path[0];
  return container === CLUSTER_CONTAINER ? "" : ` -n ${container}`;
}

/** The stored segment: the object (`deployment/web`) or the custom resource type (`widgets.probe.libredb.dev`). */
function segmentOf(path: readonly string[]): string {
  return path[path.length - 1];
}

/** A tree click and Generate Command: one get of the object, or of a custom resource type's objects. */
export function kubectlGetQuery(path: readonly string[]): string {
  return `kubectl get ${segmentOf(path)}${namespaceFlag(path)}`;
}

/** The statement of a declared row action: Describe, Logs (the last 50 lines, also a pod row's click) or List. */
export function kubectlRowActionQuery(path: readonly string[], actionId: string): string {
  if (actionId === "describe") return `kubectl describe ${segmentOf(path)}${namespaceFlag(path)}`;
  if (actionId === "logs")
    return `kubectl logs ${segmentOf(path)}${namespaceFlag(path)} --tail=${KUBERNETES_LOG_ROW_TAIL}`;
  if (actionId === "list") return kubectlGetQuery(path);
  throw new Error(`Kubernetes declares no row action "${actionId}"`);
}
