/**
 * The sessions member of an agent tool context built by a test of a legacy engine's run (`AgentToolContext.sessions`
 * in src/lib/agent/tools.ts): the drive builds it for every record, and only a provider package's engine's grounding
 * walk, curated readings and statements open it, so a legacy run that calls it is a test defect and is refused by name.
 */
import type { AgentEngineSessions } from "@/lib/agent/tools";

export const LEGACY_RUN_SESSIONS: AgentEngineSessions = Object.freeze({
  metadataTree: () => Promise.reject(new Error("a legacy engine's run opens no package session: a test defect")),
  monitoring: () => Promise.reject(new Error("a legacy engine's run opens no package session: a test defect")),
  readOnlyStatements: () => Promise.reject(new Error("a legacy engine's run opens no package session: a test defect")),
});
