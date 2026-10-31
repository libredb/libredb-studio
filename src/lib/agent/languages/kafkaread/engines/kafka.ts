/**
 * Kafka's server overlay. The kafkaread request language declares no dialect-bound member, so the overlay is empty
 * and the engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const KAFKA_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"kafkaread">;
