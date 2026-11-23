/**
 * The caps a kubectl statement is read against, declared once for the kubectl statement language: the parser bounds a
 * get's names, `--tail` and `--limit-bytes` by them, and the paging clause pages by the first two. Pure and
 * browser-safe, importing nothing. The Kubernetes provider's list walks and readers apply the same caps and import
 * them from here; every other cap of the provider stays in its `limits.ts`, and no module restates one.
 *
 * A value above a cap is refused with a sentence naming the cap, never clamped.
 */
/** Objects per list request. */
export const KUBERNETES_PAGE_SIZE = 500;
/** Rows one console statement may read. */
export const KUBERNETES_MAX_STATEMENT_ROWS = 5_000;
/** Objects one `-o json|yaml` statement may show. */
export const KUBERNETES_MAX_DOCUMENT_OBJECTS = 500;
/** The most log lines `--tail` may ask for. */
export const KUBERNETES_LOG_TAIL_MAX = 5_000;
/** The `limitBytes` of every log request, and the most `--limit-bytes` may ask for. */
export const KUBERNETES_LOG_LIMIT_BYTES = 1024 * 1024;
