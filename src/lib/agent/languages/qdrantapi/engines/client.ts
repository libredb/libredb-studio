/**
 * Qdrant's client overlay. The Qdrant request language declares no dialect-bound member, so the overlay is empty
 * and the engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const QDRANT_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"qdrantapi">;
