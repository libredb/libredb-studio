/**
 * The s3api command language as one pack: its client and server facets. Its variants offer the read and the report
 * only, so it has no tool arms and no evidence tools. Execution tier, above `tools.ts`.
 */
import type { AgentLanguagePack } from "../pack";
import { S3API_CLIENT_PACK } from "./client";
import { S3API_SERVER_PACK } from "./server";

export const S3API_PACK = Object.freeze({
  id: "s3api",
  client: S3API_CLIENT_PACK,
  server: S3API_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
