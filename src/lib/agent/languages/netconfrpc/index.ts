/**
 * The netconfrpc request language as one pack: its client and server facets. Its variants offer the read and the
 * report only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { NETCONFRPC_CLIENT_PACK } from "./client";
import { NETCONFRPC_SERVER_PACK } from "./server";

export const NETCONFRPC_PACK = Object.freeze({
  id: "netconfrpc",
  client: NETCONFRPC_CLIENT_PACK,
  server: NETCONFRPC_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
