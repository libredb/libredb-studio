import { describe, expect, test } from "bun:test";
import * as limits from "@/lib/db/providers/platform/kubernetes/limits";

describe("kubernetes limits", () => {
  test("every cap of the provider's limits table, by value", () => {
    expect({
      page: limits.KUBERNETES_PAGE_SIZE,
      statementRows: limits.KUBERNETES_MAX_STATEMENT_ROWS,
      treeObjects: limits.KUBERNETES_TREE_OBJECT_CAP,
      responseBytes: limits.KUBERNETES_MAX_RESPONSE_BYTES,
      documentBytes: limits.KUBERNETES_MAX_DOCUMENT_BYTES,
      documentObjects: limits.KUBERNETES_MAX_DOCUMENT_OBJECTS,
      documentsBytes: limits.KUBERNETES_MAX_DOCUMENTS_BYTES,
      logTailDefault: limits.KUBERNETES_LOG_TAIL_DEFAULT,
      logRowTail: limits.KUBERNETES_LOG_ROW_TAIL,
      logTailMax: limits.KUBERNETES_LOG_TAIL_MAX,
      logSelectorTail: limits.KUBERNETES_LOG_SELECTOR_TAIL,
      logLimitBytes: limits.KUBERNETES_LOG_LIMIT_BYTES,
      logStreams: limits.KUBERNETES_MAX_LOG_STREAMS,
      watchSeconds: limits.KUBERNETES_WATCH_WINDOW_SECONDS,
      watchBytes: limits.KUBERNETES_WATCH_WINDOW_BYTES,
      windowMarginMs: limits.KUBERNETES_WINDOW_MARGIN_MS,
      eventsRead: limits.KUBERNETES_EVENTS_READ_MAX,
      eventsShown: limits.KUBERNETES_EVENTS_SHOWN,
      explainBytes: limits.KUBERNETES_EXPLAIN_DOCUMENT_BYTES,
      discoveryTtlMs: limits.KUBERNETES_DISCOVERY_TTL_MS,
      retryAfterMaxMs: limits.KUBERNETES_RETRY_AFTER_MAX_MS,
      retryAfterDefaultMs: limits.KUBERNETES_RETRY_AFTER_DEFAULT_MS,
      retryJitterMs: limits.KUBERNETES_RETRY_JITTER_MS,
      kubeconfigBytes: limits.KUBERNETES_KUBECONFIG_MAX_BYTES,
      kubeconfigDepth: limits.KUBERNETES_KUBECONFIG_MAX_DEPTH,
      emptyPages: limits.KUBERNETES_MAX_EMPTY_PAGES,
    }).toEqual({
      page: 500,
      statementRows: 5000,
      treeObjects: 1000,
      responseBytes: 16777216,
      documentBytes: 1048576,
      documentObjects: 500,
      documentsBytes: 16777216,
      logTailDefault: 500,
      logRowTail: 50,
      logTailMax: 5000,
      logSelectorTail: 10,
      logLimitBytes: 1048576,
      logStreams: 5,
      watchSeconds: 10,
      watchBytes: 8388608,
      windowMarginMs: 5000,
      eventsRead: 5000,
      eventsShown: 1000,
      explainBytes: 4194304,
      discoveryTtlMs: 600000,
      retryAfterMaxMs: 5000,
      retryAfterDefaultMs: 1000,
      retryJitterMs: 250,
      kubeconfigBytes: 1048576,
      kubeconfigDepth: 100,
      emptyPages: 10,
    });
  });

  test("the identity constants: the type id, port 6443 and four calls in flight", () => {
    expect(String(limits.KUBERNETES_TYPE)).toBe("kubernetes");
    expect(limits.KUBERNETES_DEFAULT_PORT).toBe(6443);
    expect(limits.KUBERNETES_MAX_IN_FLIGHT).toBe(4);
  });
});
