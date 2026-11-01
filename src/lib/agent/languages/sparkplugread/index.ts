/**
 * The sparkplugread request language as one pack: its client and server facets. Its variants offer the read and the
 * report only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { SPARKPLUGREAD_CLIENT_PACK } from "./client";
import { SPARKPLUGREAD_SERVER_PACK } from "./server";

export const SPARKPLUGREAD_PACK = Object.freeze({
  id: "sparkplugread",
  client: SPARKPLUGREAD_CLIENT_PACK,
  server: SPARKPLUGREAD_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
