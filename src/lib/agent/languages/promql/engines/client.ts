/**
 * Prometheus's client overlay. The PromQL language declares no dialect-bound member, so the overlay is empty and the
 * engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const PROMETHEUS_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"promql">;
