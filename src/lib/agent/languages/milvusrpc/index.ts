/**
 * The Milvus request language as one pack: its client and server facets. Its variants offer the read and the report
 * only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { MILVUSRPC_CLIENT_PACK } from "./client";
import { MILVUSRPC_SERVER_PACK } from "./server";

export const MILVUSRPC_PACK = Object.freeze({
  id: "milvusrpc",
  client: MILVUSRPC_CLIENT_PACK,
  server: MILVUSRPC_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
