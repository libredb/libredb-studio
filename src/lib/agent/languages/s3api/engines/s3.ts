/**
 * S3's server overlay. The s3api command language declares no dialect-bound member, so the overlay is empty and the
 * engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const S3_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"s3api">;
