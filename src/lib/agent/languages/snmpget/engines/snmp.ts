/**
 * SNMP's server overlay. The snmpget command language declares no dialect-bound member, so the overlay is empty and
 * the engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const SNMP_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"snmpget">;
