/**
 * The tree surface: the containers (`Cluster`, then the namespaces) with the kinds each holds. The counts and the
 * capped listings join this module in the next task.
 */
import { QueryError } from "@/lib/db/errors";
import { assertContainerPathShape, type ContainerPathShapeEngine } from "@/lib/db/object-kinds";
import type { Container, ContainerLevels, ProviderCapabilities } from "@/lib/db/types";
import { ACCEPT_TABLE, type KubernetesCall, type KubernetesClient } from "./client";
import type { ClusterEndpoint } from "./connection-options";
import { DNS1123_LABEL } from "./connection-options";
import { type DiscoveryCache, findResource, type IndexedResource, type ResourceIndex } from "./discovery";
import { KubernetesRequestError } from "./errors";
import { CLUSTER_CONTAINER, kindsForContainerName } from "./kinds";
import { KUBERNETES_PAGE_SIZE, KUBERNETES_TREE_OBJECT_CAP, KUBERNETES_TYPE } from "./limits";
import { redactResponse } from "./redaction";
import { cellOf, type KubeTable, parseTable, scanTable, type TableRow } from "./table";

/** What every tree read goes through: the client, the discovery cache, the connection's namespaces and a fresh call. */
export interface KubernetesSurface {
  readonly client: KubernetesClient;
  readonly discovery: DiscoveryCache;
  readonly endpoint: Pick<ClusterEndpoint, "namespaces" | "defaultNamespace">;
  readonly call: () => KubernetesCall;
}

function refuse(message: string): never {
  throw new QueryError(message, KUBERNETES_TYPE);
}

/** The container declaration the provider's capabilities carry: one Namespace level, exact paths only. */
export const KUBERNETES_CONTAINER_LEVELS: ContainerLevels = [
  { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
];

const KUBERNETES_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: KUBERNETES_TYPE,
  label: "A Kubernetes",
  shapeNames: "label",
};

/** The one segment of a container path: `Cluster` or a namespace name. */
export function containerName(container: readonly string[]): string {
  // The shared check reads the two container fields alone, which is all this declaration carries.
  const declaration: Pick<ProviderCapabilities, "containerLevels" | "containerPathShapes"> = {
    containerLevels: KUBERNETES_CONTAINER_LEVELS,
    containerPathShapes: "exact",
  };
  assertContainerPathShape(declaration as ProviderCapabilities, container, KUBERNETES_CONTAINER_PATH_ENGINE);
  const [name] = container;
  if (name !== CLUSTER_CONTAINER && !DNS1123_LABEL.test(name))
    refuse(
      `A Kubernetes container is Cluster or a namespace name (a DNS-1123 label), received ${JSON.stringify(name)}`,
    );
  return name;
}

/** One page reader of a Table list: requested with `includeObject=None`, redacted, parsed. */
function tableReader(surface: KubernetesSurface, target: IndexedResource, namespace: string | undefined) {
  return async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await surface.client.json(
      {
        op: "list",
        target,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          includeObject: "None",
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...surface.call(), accept: ACCEPT_TABLE },
    );
    return parseTable(redactResponse(target, body));
  };
}

function rowName(table: Pick<KubeTable, "columns">, row: TableRow, labelPlural: string): string {
  const name = cellOf(table, row, "Name");
  if (typeof name !== "string" || name === "")
    refuse(`The API server listed one of the ${labelPlural} without a name.`);
  return name;
}

/** The namespaces the tree lists: `forbidden` when the API refused the list. */
export interface NamespaceList {
  readonly names: readonly string[];
  readonly forbidden: boolean;
  /** Present only when the API listed more namespaces than the tree's cap; `names` then holds the first 1,000. */
  readonly capped?: true;
}

/** The namespaces from the API, the first 1,000 read one past the cap, or `forbidden` when the list is refused. */
async function namespacesFromApi(surface: KubernetesSurface, index: ResourceIndex): Promise<NamespaceList> {
  const sources: readonly (readonly [group: string, resource: string])[] = [
    ["", "namespaces"],
    // OpenShift project users may list projects where they may not list namespaces.
    ["project.openshift.io", "projects"],
  ];
  for (const [group, resource] of sources) {
    const target = findResource(index, group, resource);
    if (target === undefined || !target.verbs.includes("list")) continue;
    try {
      const scan = await scanTable(tableReader(surface, target, undefined), {
        offset: 0,
        // One row past the cap, as a count reads, so a cluster with more namespaces than the tree lists is told so.
        limit: KUBERNETES_TREE_OBJECT_CAP + 1,
        pageSize: KUBERNETES_PAGE_SIZE,
      });
      const names = scan.rows.map((row) => rowName(scan, row, "namespaces"));
      if (names.length > KUBERNETES_TREE_OBJECT_CAP)
        return { names: names.slice(0, KUBERNETES_TREE_OBJECT_CAP), forbidden: false, capped: true };
      return { names, forbidden: false };
    } catch (error) {
      if (!(error instanceof KubernetesRequestError) || error.status !== 403) throw error;
    }
  }
  return { names: [surface.endpoint.defaultNamespace], forbidden: true };
}

/** The namespaces the tree lists, whether the API refused the namespace list, and whether it held more than 1,000. */
export async function listNamespaces(surface: KubernetesSurface): Promise<NamespaceList> {
  if (surface.endpoint.namespaces !== undefined) return { names: surface.endpoint.namespaces, forbidden: false };
  return namespacesFromApi(surface, await surface.discovery.get());
}

/** `Cluster` first, then the namespaces, each with the kinds it holds; the default namespace is the session's. */
export async function listKubernetesContainers(
  surface: KubernetesSurface,
  parent?: readonly string[],
): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];
  const { names } = await listNamespaces(surface);
  return [
    { path: [CLUSTER_CONTAINER], name: CLUSTER_CONTAINER, level: 0, kinds: kindsForContainerName(CLUSTER_CONTAINER) },
    ...names.map(
      (name): Container => ({
        path: [name],
        name,
        level: 0,
        ...(name === surface.endpoint.defaultNamespace ? { isSessionDefault: true } : {}),
        kinds: kindsForContainerName(name),
      }),
    ),
  ];
}
