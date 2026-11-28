/**
 * The engine packs, whole (#1821): one engine's family pack with the engine's overlays applied.
 *
 * Execution tier, like `languages/index.ts`, whose packs it overlays. Nothing in the run loop reads it yet: the run
 * reads its family pack (`agentLanguagePack`), and `tests/unit/lib/agent/engine-overlays.test.ts` holds every engine
 * pack to that family pack member for member, so moving a reader onto this resolver changes nothing it reads.
 */
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { agentLanguagePack } from "../index";
import { grantedAgentStatementLanguage } from "../client";
import type { AgentEnginePack } from "../pack";
import { engineClientPack, engineFamily } from "./client";
import { runServerPack } from "./server";

/**
 * The pack of engine `id`, read from its record in the server's engine catalog (`servedEngineRecord`): its family pack
 * itself when neither overlay changes a facet, or when its record grants it a family its overlays are not of (a
 * language declared as data, or a provider package's engine, which has no overlay), otherwise a frozen pack holding
 * the overlaid facets and the family's execution facet. Its family is the `statementLanguage` grant of its record
 * (`grantedAgentStatementLanguage`). An engine whose record grants it no statement language has none, and asking is a
 * named error.
 *
 * @throws {Error} Naming the engine, where its engine record grants it no statement language.
 * @throws {UnknownProviderError} When `id` names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function agentEnginePack(id: string): AgentEnginePack {
  const engine = servedEngineRecord(id);
  const language = grantedAgentStatementLanguage(engine);
  if (language === null) throw new Error(`no engine pack for ${id}: Studio grants it no statement language`);
  const client = engineClientPack(engine);
  const family = agentLanguagePack(language);
  const server = runServerPack(family.id, id);
  if (engineFamily(engine) !== language || (client === family.client && server === family.server)) return family;
  return Object.freeze({ id: family.id, client, server, execution: family.execution });
}
