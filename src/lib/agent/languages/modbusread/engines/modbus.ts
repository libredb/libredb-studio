/**
 * Modbus's server overlay. The modbusread request language declares no dialect-bound member, so the overlay is empty
 * and the engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const MODBUS_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"modbusread">;
