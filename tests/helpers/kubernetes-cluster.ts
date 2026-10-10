/**
 * A fake API server for the Kubernetes tests, answered through the recording transport: discovery, paged Table lists
 * that honour `limit` and `continue`, objects by path, 403s by path, the self reviews and the health endpoints. Every
 * answer is synthesized from the options; nothing here was captured from a cluster.
 */
import type { NodeResponse } from "@/lib/db/http/node-transport";
import { createKubernetesClient, type KubernetesCall } from "@/lib/db/providers/platform/kubernetes/client";
import { readClusterEndpoint } from "@/lib/db/providers/platform/kubernetes/connection-options";
import { DiscoveryCache, readDiscovery } from "@/lib/db/providers/platform/kubernetes/discovery";
import type { KubernetesSurface } from "@/lib/db/providers/platform/kubernetes/objects";
import type { DatabaseConnection } from "@/lib/types";
import { kubernetesConnection } from "./kubernetes-connection";
import { CORE_DISCOVERY, GROUPS_DISCOVERY } from "./kubernetes-discovery";
import {
  jsonAnswer,
  type KubernetesAnswerFn,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "./kubernetes-transport";

export interface FakeRow {
  readonly name: string;
  /** The Name cell when the printer writes more than the name, as StorageClass's ` (default)`; the name otherwise. */
  readonly cell?: string;
  readonly ready?: string;
  readonly status?: string;
}

export interface FakeClusterOptions {
  readonly core?: unknown;
  readonly groups?: unknown;
  /** Collection path (no query) to its rows, in the server's order. */
  readonly lists?: Readonly<Record<string, readonly FakeRow[]>>;
  /** Object path to its JSON body. */
  readonly objects?: Readonly<Record<string, unknown>>;
  /** Collection paths whose empty page answers `rows: null`, as the default Table convertor does. */
  readonly rowsNull?: readonly string[];
  /** Paths (no query) that answer 403. */
  readonly forbidden?: readonly string[];
  /** The `status.allowed` a SelfSubjectAccessReview body answers. */
  readonly allows?: (attributes: Readonly<Record<string, unknown>>) => boolean;
  readonly version?: unknown;
  /** The `/readyz` answer's status. */
  readonly readyzStatus?: number;
}

const COLUMNS = [
  { name: "Name", type: "string", format: "name", priority: 0 },
  { name: "Ready", type: "string", format: "", priority: 0 },
  { name: "Status", type: "string", format: "", priority: 0 },
  { name: "Age", type: "string", format: "", priority: 0 },
];

function page(rows: readonly FakeRow[], search: URLSearchParams, rowsNull: boolean): NodeResponse {
  const start = Number(search.get("continue") ?? "0");
  const limit = Number(search.get("limit") ?? String(rows.length));
  const slice = rows.slice(start, start + limit);
  const end = start + slice.length;
  // With includeObject=Metadata each row carries its object's metadata, as a PartialObjectMetadata.
  const metadata = search.get("includeObject") === "Metadata";
  return jsonAnswer({
    kind: "Table",
    apiVersion: "meta.k8s.io/v1",
    metadata: { resourceVersion: "100", ...(end < rows.length ? { continue: String(end) } : {}) },
    columnDefinitions: COLUMNS,
    rows:
      rowsNull && slice.length === 0
        ? null
        : slice.map((row) => ({
            cells: [row.cell ?? row.name, row.ready ?? "", row.status ?? "", "5m"],
            ...(metadata
              ? {
                  object: {
                    kind: "PartialObjectMetadata",
                    apiVersion: "meta.k8s.io/v1",
                    metadata: { name: row.name },
                  },
                }
              : {}),
          })),
  });
}

export function fakeCluster(options: FakeClusterOptions = {}): KubernetesAnswerFn {
  return (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (options.forbidden?.includes(path)) return statusAnswer(403, "Forbidden");
    if (path === "/api" || path.endsWith("/api")) return jsonAnswer(options.core ?? CORE_DISCOVERY);
    if (path === "/apis" || path.endsWith("/apis")) return jsonAnswer(options.groups ?? GROUPS_DISCOVERY);
    if (path.endsWith("/version"))
      return jsonAnswer(
        options.version ?? { major: "1", minor: "35", gitVersion: "v1.35.5+k3s1", platform: "linux/amd64" },
      );
    if (path.endsWith("/readyz"))
      return { status: options.readyzStatus ?? 200, contentType: "text/plain", retryAfter: null, text: "ok" };
    if (path.endsWith("/selfsubjectaccessreviews")) {
      const body = JSON.parse(request.body ?? "{}") as { spec?: { resourceAttributes?: Record<string, unknown> } };
      const attributes = body.spec?.resourceAttributes ?? {};
      return jsonAnswer({ ...body, status: { allowed: options.allows?.(attributes) ?? false } }, 201);
    }
    const rows = options.lists?.[path];
    if (rows !== undefined) return page(rows, url.searchParams, options.rowsNull?.includes(path) === true);
    const object = options.objects?.[path];
    if (object !== undefined) return jsonAnswer(object);
    return statusAnswer(404, "NotFound");
  };
}

/** `count` rows named `<prefix>-0` onward. */
export function manyRows(prefix: string, count: number): FakeRow[] {
  return Array.from({ length: count }, (_unused, index) => ({ name: `${prefix}-${index}` }));
}

/** A tree surface over a recording transport answered by `answer`, for a connection with `overrides`. */
export function testSurface(
  answer: KubernetesAnswerFn,
  overrides?: Partial<DatabaseConnection>,
  options: { readonly queryTimeout?: number } = {},
) {
  const transport = recordingKubernetesTransport(answer);
  const seams = testSeams(transport);
  const endpoint = readClusterEndpoint(kubernetesConnection(overrides), {
    queryTimeout: options.queryTimeout ?? 30_000,
    appVersion: null,
  });
  const client = createKubernetesClient(endpoint, seams);
  const call = (): KubernetesCall => ({ signal: new AbortController().signal, timeoutMs: endpoint.callTimeoutMs });
  const discovery = new DiscoveryCache(() => readDiscovery(client, call()), seams.now);
  const surface: KubernetesSurface = { client, discovery, endpoint, call };
  return { surface, transport };
}
