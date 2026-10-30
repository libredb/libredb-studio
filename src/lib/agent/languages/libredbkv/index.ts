/**
 * The LibreDB command language as one pack: its client and server facets. Its variants offer the read and the report
 * only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { LIBREDBKV_CLIENT_PACK } from "./client";
import { LIBREDBKV_SERVER_PACK } from "./server";

export const LIBREDBKV_PACK = Object.freeze({
  id: "libredbkv",
  client: LIBREDBKV_CLIENT_PACK,
  server: LIBREDBKV_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
