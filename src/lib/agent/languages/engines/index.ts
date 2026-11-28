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
import { servedClientPacks } from "../server";
import { engineClientPack, engineFamily } from "./client";
import { runServerPack } from "./server";

/**
 * The pack of engine `id`, read from its record (`servedEngineRecord`) and the server's registry (`servedClientPacks`):
 * its family pack itself when neither overlay changes a facet or its record grants a family its overlays are not of
 * (a declared language, or a package's engine), otherwise a frozen pack of the overlaid facets and the family's
 * execution facet. Its family is its record's grant (`grantedAgentStatementLanguage`); with none, asking is an error.
 *
 * @throws {Error} Naming the engine, where its engine record grants it no statement language.
 * @throws {UnknownProviderError} When `id` names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function agentEnginePack(id: string): AgentEnginePack {
  const engine = servedEngineRecord(id);
  const packs = servedClientPacks();
  const language = grantedAgentStatementLanguage(engine, packs);
  if (language === null) throw new Error(`no engine pack for ${id}: Studio grants it no statement language`);
  const client = engineClientPack(engine, packs);
  const family = agentLanguagePack(language);
  const server = runServerPack(family.id, id);
  if (engineFamily(engine, packs) !== language || (client === family.client && server === family.server)) return family;
  return Object.freeze({ id: family.id, client, server, execution: family.execution });
}
