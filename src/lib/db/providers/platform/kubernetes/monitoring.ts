/**
 * Health and the overview of a Kubernetes connection: `/readyz` and `/version` for health; the version, the namespace
 * count and the node count for the overview, both counted from the same capped walk as the tree (exact up to 1,000,
 * a floor past it). The shared overview card that draws `tableCount` is titled Tables; for Kubernetes it holds the
 * namespaces, and the node count is the size card's text, the Prometheus and etcd precedent of drawing an engine's
 * own count there. Every other getter answers empty, and the labels say why.
 */
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import { findResource } from "./discovery";
import { KubernetesRequestError } from "./errors";
import { cappedCount, type KubernetesSurface, listNamespaces } from "./objects";

/** `/readyz` must answer 2xx, then `/version` is read; either failing fails health with its sentence. */
export async function kubernetesHealth(surface: KubernetesSurface): Promise<HealthInfo> {
  await surface.client.send({ op: "readyz" }, { ...surface.call(), accept: "text/plain" });
  await surface.client.json({ op: "version" }, surface.call());
  // No count of connections is reported, which is a different fact from zero.
  return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}

function versionOf(body: unknown): string {
  const version =
    typeof body === "object" && body !== null ? (body as { readonly gitVersion?: unknown }).gitVersion : undefined;
  return typeof version === "string" && version !== "" ? version : "N/A";
}

/** The node count in words: a number, a floor, or why it is not known. */
async function nodeWords(surface: KubernetesSurface): Promise<string> {
  const nodes = findResource(await surface.discovery.get(), "", "nodes");
  if (nodes === undefined || !nodes.verbs.includes("list")) return "nodes not served";
  try {
    const count = await cappedCount(surface, nodes, undefined);
    if ("sampledFrom" in count) return `${count.count.toLocaleString("en-US")} or more nodes`;
    return count.count === 1 ? "1 node" : `${count.count} nodes`;
  } catch (error) {
    if (error instanceof KubernetesRequestError && error.status === 403) return "nodes not readable by this identity";
    throw error;
  }
}

export async function kubernetesOverview(surface: KubernetesSurface): Promise<DatabaseOverview> {
  const [version, namespaces, nodes] = await Promise.all([
    surface.client.json({ op: "version" }, surface.call()),
    listNamespaces(surface),
    nodeWords(surface),
  ]);
  return {
    version: versionOf(version),
    uptime: "N/A",
    maxConnections: 0,
    databaseSize: nodes,
    tableCount: namespaces.names.length,
    ...(namespaces.forbidden
      ? { tableCountSampledFrom: "the Default namespace alone, because this identity may not list namespaces" }
      : {}),
    // Past the tree's cap the count is a floor, drawn as 1,000+, like every count of the capped walk.
    ...(namespaces.capped === true ? { tableCountSampledFrom: "the first 1,000 namespaces the API listed" } : {}),
    indexCount: 0,
  };
}
