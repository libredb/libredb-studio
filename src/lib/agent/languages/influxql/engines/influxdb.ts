/**
 * InfluxDB's server overlay. The InfluxQL language declares no dialect-bound member, so the overlay is empty and the
 * engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const INFLUXDB_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"influxql">;
