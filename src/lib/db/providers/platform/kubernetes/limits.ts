/**
 * The Kubernetes provider's identity and every numeric cap it applies, in one module that imports nothing at run
 * time, so the browser-side kubeconfig importer can read the paste cap without reaching the provider's server code.
 *
 * A value above a cap is refused with a sentence naming the cap, never clamped.
 */
import type { DatabaseType } from "@/lib/types";

/** The provider's type id, the one every error of this provider is tagged with. */
export const KUBERNETES_TYPE: DatabaseType = "kubernetes";
/** kubeadm, k3s and kind serve the API on 6443; managed clusters usually on 443. */
export const KUBERNETES_DEFAULT_PORT = 6443;
/** The calls in flight for one connection, and so the sockets of its one Agent. */
export const KUBERNETES_MAX_IN_FLIGHT = 4;

/** Objects per list request. */
export const KUBERNETES_PAGE_SIZE = 500;
/** Rows one console statement may read. */
export const KUBERNETES_MAX_STATEMENT_ROWS = 5_000;
/**
 * Pages of one list walk that may hold no object yet carry a continue token. A selector can leave a page empty, but a
 * server that keeps answering such pages would hold the walk for ever, so past this many it stops.
 */
export const KUBERNETES_MAX_EMPTY_PAGES = 10;
/** Objects the tree lists per kind and container; the folder still shows the true count. */
export const KUBERNETES_TREE_OBJECT_CAP = 1_000;
/** Bytes one response may hold. */
export const KUBERNETES_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Bytes one `-o json|yaml` document cell may hold. */
export const KUBERNETES_MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Bytes the documents of one `-o json|yaml` statement may hold together. */
export const KUBERNETES_MAX_DOCUMENTS_BYTES = 16 * 1024 * 1024;
/** Objects one `-o json|yaml` statement may show. */
export const KUBERNETES_MAX_DOCUMENT_OBJECTS = 500;
/** Log lines read when `--tail` is absent. */
export const KUBERNETES_LOG_TAIL_DEFAULT = 500;
/**
 * Log lines a pod's Logs row action reads, and so a click on a pod row: the 50 rows a click on a table previews
 * (`PREVIEW_PAGE_SIZE` in `src/hooks/use-tab-manager.ts`), so one gesture reads a page of either. The statement says
 * `--tail=50`, so the reader sees the bound and can raise it in the editor.
 */
export const KUBERNETES_LOG_ROW_TAIL = 50;
/** The most log lines `--tail` may ask for. */
export const KUBERNETES_LOG_TAIL_MAX = 5_000;
/** Log lines per pod when `-l` selects the pods and `--tail` is absent, as kubectl reads them. */
export const KUBERNETES_LOG_SELECTOR_TAIL = 10;
/** The `limitBytes` of every log request, and the most `--limit-bytes` may ask for. */
export const KUBERNETES_LOG_LIMIT_BYTES = 1024 * 1024;
/** Log streams one statement may open, kubectl's `--max-log-requests` default. */
export const KUBERNETES_MAX_LOG_STREAMS = 5;
/** The bounded watch window when `--request-timeout` is absent, in seconds. */
export const KUBERNETES_WATCH_WINDOW_SECONDS = 10;
/** Bytes one bounded watch window may hold. */
export const KUBERNETES_WATCH_WINDOW_BYTES = 8 * 1024 * 1024;
/** How much longer than the server's window the client waits, and how far below the query timeout a window ends. */
export const KUBERNETES_WINDOW_MARGIN_MS = 5_000;
/** Events `events` reads at most. */
export const KUBERNETES_EVENTS_READ_MAX = 5_000;
/** Events `events` shows, the newest. */
export const KUBERNETES_EVENTS_SHOWN = 1_000;
/**
 * How deep a parsed answer may nest its objects and arrays. The captured k3s answers nest at most 17 levels and a
 * custom resource definition's schema a few dozen; a hostile answer nested thousands deep would overflow the YAML and
 * JSON renderers' recursion.
 */
export const KUBERNETES_MAX_JSON_DEPTH = 1_000;
/** Bytes one OpenAPI group document for `explain` may hold. */
export const KUBERNETES_EXPLAIN_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** How long one connection keeps its discovery index. */
export const KUBERNETES_DISCOVERY_TTL_MS = 10 * 60 * 1000;
/** The longest one wait on a 429 may be; a longer Retry-After answers a sentence at once. */
export const KUBERNETES_RETRY_AFTER_MAX_MS = 5_000;
/** The wait on a 429 that carries no Retry-After. */
export const KUBERNETES_RETRY_AFTER_DEFAULT_MS = 1_000;
/** The widest random addition to a 429 wait, so two Studio servers do not retry in step. */
export const KUBERNETES_RETRY_JITTER_MS = 250;
/** Bytes a pasted kubeconfig may hold. */
export const KUBERNETES_KUBECONFIG_MAX_BYTES = 1024 * 1024;
/**
 * How deep a pasted kubeconfig may nest, counted per line as its indentation in spaces, the `-`, `?` and `:` indicators
 * that open it and the flow brackets still open. kubectl writes fewer than 20; the YAML parser recurses per level and
 * overflowed its stack on a 60 KB paste nested 6,000 deep.
 */
export const KUBERNETES_KUBECONFIG_MAX_DEPTH = 100;
