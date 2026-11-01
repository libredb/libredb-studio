/**
 * The mtconnectread request language as one pack: its client and server facets. Its variants offer the read and the
 * report only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { MTCONNECTREAD_CLIENT_PACK } from "./client";
import { MTCONNECTREAD_SERVER_PACK } from "./server";

export const MTCONNECTREAD_PACK = Object.freeze({
  id: "mtconnectread",
  client: MTCONNECTREAD_CLIENT_PACK,
  server: MTCONNECTREAD_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
