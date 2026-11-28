/**
 * The statement language data the server's agent registries compose: the one accessor every server-side registry of a
 * language declared as data reads, after boot, from the installed server catalog (src/lib/db/server-catalog.ts).
 *
 * Server only. Its readers are the generic read descriptors (`./descriptors`) and the agent's server-side language
 * registries: the server packs (src/lib/agent/languages/server.ts), the whole packs (src/lib/agent/languages/index.ts)
 * and the MCP facets (src/lib/agent/languages/mcp.ts). The browser composes the bundled declarations' languages itself
 * (src/lib/agent/languages/client.ts), since a browser cannot read the server's catalog.
 *
 * `servedLanguageData()` answers, over the served records in catalog order (`servedEngines`), the statement language
 * data of every record whose data is stated and whose `grants.statementLanguage` names it, each by reference. A record
 * grants a language only where its register row reviewed the data it declares (its digest), so an admitted package's
 * data its row does not grant enters no registry, and a name no review saw cannot collide with a language Studio
 * holds. With nothing installed it answers the legacy records' data, which is the bundled set the browser composes.
 *
 * The answer is frozen and memoized per installed catalog, keyed by the Map of served records, so one catalog answers
 * one array and a newly installed catalog its own; each registry reading it memoizes its composition by that array.
 * A read while boot has begun and not yet installed the catalog (`serverCatalogBooting`) is refused as
 * `AgentLanguageCompositionOrderError`, a defect of Studio's own composition order, since the server serves no request
 * before the install; a read after a boot that ended by an error before its install (`serverCatalogBootUnfinished`) is
 * refused as `AgentLanguageCatalogBootUnfinishedError`, which names that boot, so no registry is composed from the
 * bundled set then.
 */
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import {
  type EngineRecord,
  servedEngines,
  serverCatalogBooting,
  serverCatalogBootUnfinished,
} from "@/lib/db/server-catalog";

/**
 * A read of agent mode's statement languages while boot has begun and not yet installed the server's engine catalog: a
 * defect of Studio's own composition order, never an answer composed from the bundled set.
 */
export class AgentLanguageCompositionOrderError extends Error {
  constructor() {
    super(
      "Agent mode's statement languages were read while the server's engine catalog was still being composed at boot. Boot installs the catalog before the server serves any request, so this read is a defect of Studio's own composition order.",
    );
    this.name = "AgentLanguageCompositionOrderError";
  }
}

/**
 * A read of agent mode's statement languages after the server's engine catalog's boot ended by an error before it
 * installed the catalog: the boot's failure, never an answer composed from the bundled set.
 */
export class AgentLanguageCatalogBootUnfinishedError extends Error {
  constructor() {
    super(
      "Agent mode's statement languages were read after the server's engine catalog's boot began and did not finish: the boot ended by an error before it installed the catalog, so no statement language is composed.",
    );
    this.name = "AgentLanguageCatalogBootUnfinishedError";
  }
}

/** Each answer, by the Map of served records it was read from. */
const SERVED = new WeakMap<ReadonlyMap<string, EngineRecord>, readonly NonNullable<StatementLanguageData>[]>();

/**
 * The statement language data of every served record whose grant names it, in catalog order, each by reference,
 * frozen, read once per installed catalog.
 *
 * @throws {AgentLanguageCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {AgentLanguageCatalogBootUnfinishedError} After a boot that ended by an error before it installed the
 *   server's engine catalog.
 */
export function servedLanguageData(): readonly NonNullable<StatementLanguageData>[] {
  if (serverCatalogBootUnfinished()) throw new AgentLanguageCatalogBootUnfinishedError();
  if (serverCatalogBooting()) throw new AgentLanguageCompositionOrderError();
  const served = servedEngines();
  let data = SERVED.get(served);
  if (data === undefined) {
    data = Object.freeze(
      [...served.values()].flatMap(({ statementLanguageData, grants }) =>
        statementLanguageData !== null && grants.statementLanguage === statementLanguageData.name
          ? [statementLanguageData]
          : [],
      ),
    );
    SERVED.set(served, data);
  }
  return data;
}
