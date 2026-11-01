/**
 * The mqttread request language as one pack: its client and server facets. Its variants offer the read and the report
 * only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { MQTTREAD_CLIENT_PACK } from "./client";
import { MQTTREAD_SERVER_PACK } from "./server";

export const MQTTREAD_PACK = Object.freeze({
  id: "mqttread",
  client: MQTTREAD_CLIENT_PACK,
  server: MQTTREAD_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
