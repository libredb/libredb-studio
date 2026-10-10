/**
 * The console's test harness: a run context over the recording transport, and a fake API server that answers by the
 * exact request line, so a test states every request a statement sends. Discovery answers the synthesized documents
 * of `kubernetes-discovery.ts`; any other line not in the map answers a `text/plain` 404, as a server does for a path
 * it does not serve. Every answer is synthesized; nothing here was captured from a cluster.
 */
import type { NodeRequest, NodeResponse } from "@/lib/db/http/node-transport";
import {
  ExplainCache,
  type KubectlContext,
  statementCall,
} from "@/lib/db/providers/platform/kubernetes/console/context";
import type { DatabaseConnection } from "@/lib/types";
import { testSurface } from "./kubernetes-cluster";
import { CORE_DISCOVERY, GROUPS_DISCOVERY } from "./kubernetes-discovery";
import { jsonAnswer, type KubernetesAnswerFn } from "./kubernetes-transport";

/** The fixed clock of every console test: 2026-10-10 12:00:00 UTC. */
export const CONSOLE_NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

/**
 * A marker that must never reach a grid cell: planted in Secret data, stringData and the last-applied annotation.
 * Joined at run time, so no commit carries a key-shaped literal for the secret scan to report.
 */
export const SECRET_MARKER = ["c2VjcmV0", "LW1hcmtlcg"].join("");

export type RouteAnswer = NodeResponse | ((request: NodeRequest) => NodeResponse | Promise<NodeResponse>);

/** A `text/plain` answer, as `/readyz`, a log and an unserved path answer. */
export function textAnswer(text: string, status = 200): NodeResponse {
  return { status, contentType: "text/plain; charset=utf-8", retryAfter: null, text };
}

/** Answers by exact request line; discovery by default; anything else a `text/plain` 404. */
export function routes(map: Readonly<Record<string, RouteAnswer>>): KubernetesAnswerFn {
  return (request, line) => {
    const routed = map[line];
    if (routed !== undefined) return typeof routed === "function" ? routed(request) : routed;
    if (line === "GET /api") return jsonAnswer(CORE_DISCOVERY);
    if (line === "GET /apis") return jsonAnswer(GROUPS_DISCOVERY);
    return textAnswer("404 page not found", 404);
  };
}

export interface TableColumnInput {
  readonly name: string;
  readonly type?: string;
  readonly priority?: number;
}

/** A meta.k8s.io Table answer. */
export function tableAnswer(
  columns: readonly TableColumnInput[],
  rows: readonly { readonly cells: readonly unknown[]; readonly object?: unknown }[],
  metadata: { readonly continue?: string; readonly resourceVersion?: string } = {},
): NodeResponse {
  return jsonAnswer({
    kind: "Table",
    apiVersion: "meta.k8s.io/v1",
    metadata: {
      resourceVersion: metadata.resourceVersion ?? "100",
      ...(metadata.continue === undefined ? {} : { continue: metadata.continue }),
    },
    columnDefinitions: columns.map((column) => ({
      name: column.name,
      type: column.type ?? "string",
      format: "",
      priority: column.priority ?? 0,
    })),
    rows,
  });
}

/** A plain list answer of `items`. */
export function listAnswer(items: readonly unknown[], metadata: { readonly continue?: string } = {}): NodeResponse {
  return jsonAnswer({ kind: "List", apiVersion: "v1", metadata: { resourceVersion: "100", ...metadata }, items });
}

/** The Secret every redaction test plants: data, stringData and a last-applied annotation that carry the marker. */
export function markerSecret(name = "db"): Record<string, unknown> {
  return {
    kind: "Secret",
    apiVersion: "v1",
    metadata: {
      name,
      namespace: "shop",
      uid: "uid-secret",
      labels: { app: "web" },
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": `{"data":{"password":"${SECRET_MARKER}"}}`,
        team: "payments",
      },
      managedFields: [{ manager: "kubectl", fieldsV1: { f: SECRET_MARKER } }],
    },
    type: "Opaque",
    data: { password: SECRET_MARKER },
    stringData: { token: SECRET_MARKER },
  };
}

/**
 * A console run context over a recording transport answered by `answer`, its statement deadline one query timeout
 * after `CONSOLE_NOW` on `now` (the fixed clock unless a test moves its own).
 */
export function consoleContext(
  answer: KubernetesAnswerFn,
  options: {
    readonly connection?: Partial<DatabaseConnection>;
    readonly queryTimeoutMs?: number;
    readonly now?: () => number;
  } = {},
) {
  const { surface, transport } = testSurface(answer, { database: "shop", ...options.connection });
  const queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
  const now = options.now ?? (() => CONSOLE_NOW);
  const context: KubectlContext = {
    surface,
    call: statementCall(new AbortController().signal, CONSOLE_NOW + queryTimeoutMs, now),
    now,
    explainCache: new ExplainCache(8),
    queryTimeoutMs,
    appVersion: "0.18.2",
  };
  return { context, transport };
}

/** The request lines a transport sent, discovery left out. */
export function sentLines(transport: { readonly calls: readonly { readonly method: string }[] }): string[] {
  return transport.calls.map((call) => call.method).filter((line) => line !== "GET /api" && line !== "GET /apis");
}
