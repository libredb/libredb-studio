/**
 * The statement language agent mode reads an engine in, from the server's engine catalog.
 *
 * Server only: it reads the installed engine record (`servedEngineRecord`), so nothing a client component imports may
 * reach it. A browser reads the same grant from the agent manifest's projection instead. It holds no knowledge of any
 * language: the grant is the engine record's, and the narrowing to the agent's languages is `agentLanguageOfGrant`'s.
 */
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseType } from "@/lib/types";
import type { AgentStatementLanguageId } from "./agent-manifest";
import { agentLanguageOfGrant } from "./languages/client";

/**
 * The agent's statement language for `type`: the `statementLanguage` grant of its engine record, read as the agent's
 * language, or null where the record grants it none.
 *
 * @throws {Error} Naming the engine and the language, where agent mode holds no pack for the granted language.
 * @throws {UnknownProviderError} When `type` names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function grantedAgentLanguage(type: DatabaseType): AgentStatementLanguageId | null {
  return agentLanguageOfGrant(type, servedEngineRecord(type).grants.statementLanguage);
}
