/**
 * MQTT's client overlay. The mqttread request language declares no dialect-bound member, so the overlay is empty and
 * the engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const MQTT_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"mqttread">;
