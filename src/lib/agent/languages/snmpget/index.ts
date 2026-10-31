/**
 * The snmpget command language as one pack: its client and server facets. Its variants offer the read and the report
 * only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { SNMPGET_CLIENT_PACK } from "./client";
import { SNMPGET_SERVER_PACK } from "./server";

export const SNMPGET_PACK = Object.freeze({
  id: "snmpget",
  client: SNMPGET_CLIENT_PACK,
  server: SNMPGET_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
