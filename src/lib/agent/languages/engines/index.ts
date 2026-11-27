/**
 * The engine packs, whole (#1821): one engine's family pack with the engine's overlays applied.
 *
 * Execution tier, like `languages/index.ts`, whose packs it overlays. Nothing in the run loop reads it yet: the run
 * reads its family pack (`agentLanguagePack`), and `tests/unit/lib/agent/engine-overlays.test.ts` holds every engine
 * pack to that family pack member for member, so moving a reader onto this resolver changes nothing it reads.
 */
import type { DatabaseType } from "@/lib/types";
import { grantedAgentLanguage } from "@/lib/agent/granted-language";
import { agentLanguagePack } from "../index";
import type { AgentEnginePack } from "../pack";
import { engineClientPack, engineFamily } from "./client";
import { runServerPack } from "./server";

/**
 * The pack of `type`: its family pack itself when neither overlay changes a facet, or when its engine record grants
 * it a family its overlays are not of (a language declared as data), otherwise a frozen pack holding the overlaid
 * facets and the family's execution facet. Its family is the `statementLanguage` grant of its engine record
 * (`grantedAgentLanguage`). A type that speaks no statement language has none, and asking is a named error: from
 * `engineClientPack` where the overlay registry holds no overlay of it, and from here where its record grants none.
 *
 * @throws {Error} Naming the type, where the overlay registry holds no overlay of it, before its record is read (so
 * every value that names no legacy engine is refused here), or where its engine record grants it no statement language.
 */
export function agentEnginePack(type: DatabaseType): AgentEnginePack {
  const client = engineClientPack(type);
  const language = grantedAgentLanguage(type);
  if (language === null) throw new Error(`no engine pack for ${type}: Studio grants it no statement language`);
  const family = agentLanguagePack(language);
  const server = runServerPack(family.id, type);
  if (engineFamily(type) !== language || (client === family.client && server === family.server)) return family;
  return Object.freeze({ id: family.id, client, server, execution: family.execution });
}
