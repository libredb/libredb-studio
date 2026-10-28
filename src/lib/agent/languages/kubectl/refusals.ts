/**
 * The refusal sentence only the kubectl readings say (#1821).
 *
 * Its code is kubectl's own `KubectlReadingDenyCode`, a member of the core's `AgentReadingDenyCode` because the ledger
 * persists it. The words live here, merged into `READING_REFUSAL_TEXT` by `../refusals.ts`.
 */

import type { AgentReadingDenyCode } from "../../types";

export const KUBECTL_READING_REFUSAL_TEXT = Object.freeze({
  METRICS_UNAVAILABLE:
    "This cluster serves no usage metrics (metrics.k8s.io), so nothing could be measured: metrics-server is not installed or not answering. Report that, and what your other readings established; usage cannot be read here.",
} satisfies Partial<Record<AgentReadingDenyCode, string>>);
