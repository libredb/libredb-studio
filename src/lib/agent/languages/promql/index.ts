/**
 * The PromQL language as one pack: its client and server facets. Its variants offer the read and the report only, so
 * it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { PROMQL_CLIENT_PACK } from "./client";
import { PROMQL_SERVER_PACK } from "./server";

export const PROMQL_PACK = Object.freeze({
  id: "promql",
  client: PROMQL_CLIENT_PACK,
  server: PROMQL_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
