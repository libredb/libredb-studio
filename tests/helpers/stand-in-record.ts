import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  type EngineRecord,
  forgetServerCatalog,
  installServerCatalog,
  servedEngineRecord,
} from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { withEngineRecord } from "./package-catalog";
import { STAND_IN_TYPE, type StandInFields } from "./stand-in-vocabulary";

/**
 * The stand-in statement language row of `tests/helpers/stand-in-vocabulary.ts` on a record of the server's engine
 * catalog, for the tests of the server's readers of the confirmation gate, which read the engine's record and never the
 * table keyed by type: `STAND_IN_TYPE`'s record as Studio composes it, with its statement language row replaced by a
 * frozen row that asks about nothing and decides alone, changed by `fields`.
 *
 * The record keeps every other member, so its grants are Trino's and do not grant the row's decides-alone claim: the
 * gate reads a text as SQL under Trino's grammar as well as through the row, as it reads the stand-in vocabulary row.
 * A unit test hands the record to the reader it tests; a route test installs it with `installStandInRecord`.
 */
export function standInRecord(fields: StandInFields): EngineRecord {
  const row: DestructiveVocabulary = Object.freeze({
    operations: Object.freeze(new Set<string>()),
    read: () => [],
    decidesAlone: true,
    ...fields,
  });
  return Object.freeze({ ...servedEngineRecord(STAND_IN_TYPE), statementLanguageRow: row });
}

/**
 * Installs Studio's own catalog with `STAND_IN_TYPE`'s record replaced by `standInRecord(fields)`, so a route that
 * reads the connection's engine through the catalog reads the stand-in row, and returns the function that forgets it.
 * The install is once per process, so a test forgets it before the next one installs.
 */
export function installStandInRecord(fields: StandInFields): () => void {
  const catalog = composeServerCatalog([], [], STUDIO_GRANT_REGISTER);
  installServerCatalog(withEngineRecord(catalog, STAND_IN_TYPE, () => standInRecord(fields)));
  return forgetServerCatalog;
}
