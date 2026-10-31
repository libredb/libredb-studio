/**
 * The kafkaread request language as one pack: its client and server facets. Its variants offer the read and the
 * report only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { KAFKAREAD_CLIENT_PACK } from "./client";
import { KAFKAREAD_SERVER_PACK } from "./server";

export const KAFKAREAD_PACK = Object.freeze({
  id: "kafkaread",
  client: KAFKAREAD_CLIENT_PACK,
  server: KAFKAREAD_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
