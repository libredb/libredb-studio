/**
 * The engine packs, whole (#1821): one engine's family pack with the engine's overlays applied.
 *
 * Execution tier, like `languages/index.ts`, whose packs it overlays. Nothing in the run loop reads it yet: the run
 * reads its family pack (`agentLanguagePack`), and `tests/unit/lib/agent/engine-overlays.test.ts` holds every engine
 * pack to that family pack member for member, so moving a reader onto this resolver changes nothing it reads.
 */
import type { DatabaseType } from "@/lib/types";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { agentLanguagePack } from "../index";
import type { AgentEnginePack } from "../pack";
import { engineClientPack } from "./client";
import { agentLanguageOfGrant } from "../client";
import { runServerPack } from "./server";

/**
 * The pack of `type`: its family pack itself when neither overlay changes a facet, otherwise a frozen pack holding the
 * overlaid facets and the family's execution facet. Its family is Studio's grant of the engine's statement language,
 * the `statementLanguage` grant of its engine record (`servedEngineRecord`). A type that speaks no statement language
 * has none, and asking is a named error: from `engineClientPack` where the overlay registry holds no overlay of it, as
 * it is for a language pack, and from here where its engine record grants it no statement language.
 *
 * @throws {Error} Naming the type, where the overlay registry holds no overlay of it, before its record is read (so
 * every value that names no legacy engine is refused here), or where its engine record grants it no statement language.
 */
export function agentEnginePack(type: DatabaseType): AgentEnginePack {
  const client = engineClientPack(type);
  const language = agentLanguageOfGrant(type, servedEngineRecord(type).grants.statementLanguage);
  if (language === null) throw new Error(`no engine pack for ${type}: Studio grants it no statement language`);
  const family = agentLanguagePack(language);
  const server = runServerPack(family.id, type);
  if (client === family.client && server === family.server) return family;
  return Object.freeze({ id: family.id, client, server, execution: family.execution });
}
