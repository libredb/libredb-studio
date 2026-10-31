/**
 * S3's client overlay. The s3api command language declares no dialect-bound member, so the overlay is empty and the
 * engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const S3_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"s3api">;
