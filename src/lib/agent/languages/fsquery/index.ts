/**
 * The fsquery statement language as one pack: its client and server facets. Its variants offer the read and the
 * report only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { FSQUERY_CLIENT_PACK } from "./client";
import { FSQUERY_SERVER_PACK } from "./server";

export const FSQUERY_PACK = Object.freeze({
  id: "fsquery",
  client: FSQUERY_CLIENT_PACK,
  server: FSQUERY_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
