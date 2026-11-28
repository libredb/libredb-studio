/**
 * The statement language agent mode reads an engine in, from the server's engine catalog.
 *
 * Server only: it reads the installed engine record (`servedEngineRecord`) and the server's registry of client facets
 * composed from the installed catalog (`servedClientPacks`), so nothing a client component imports may reach it. A
 * browser reads the same grant from the legacy engine's grants instead (`legacyAgentEngine`), against its bundled
 * composition. It holds no knowledge of any language: the grant is the engine record's, and the narrowing to the
 * agent's languages is `grantedAgentStatementLanguage`'s.
 */
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { AgentStatementLanguageId } from "./agent-manifest";
import { grantedAgentStatementLanguage } from "./languages/client";
import { servedClientPacks } from "./languages/server";

/**
 * The agent's statement language for engine `id`: the `statementLanguage` grant of its engine record, a legacy
 * engine's or a provider package's, read as the agent's language against the server's registry, or null where the
 * record grants it none. A package engine granted its own declared language under its data's digest has it, since the
 * installed catalog composes that language.
 *
 * @throws {Error} Naming the engine and the language, where the server's registry holds no pack for the granted
 *   language.
 * @throws {UnknownProviderError} When `id` names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {AgentLanguageCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {AgentLanguageCatalogBootUnfinishedError} After a boot that ended by an error before it installed the
 *   server's engine catalog.
 */
export function grantedAgentLanguage(id: string): AgentStatementLanguageId | null {
  return grantedAgentStatementLanguage(servedEngineRecord(id), servedClientPacks());
}
