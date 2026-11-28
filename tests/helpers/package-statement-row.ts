/**
 * A provider package's engine whose register row grants every MCP statement claim and the SQL statement language, and
 * reviews no grammar, composed in memory (tests/helpers/package-catalog.ts) for the MCP statement tools' tests: no
 * statement tool serves it while its record offers no execution profile, so each refuses it by name before any open,
 * fence or query event. Its package's implementation is empty, so an open of it would fail the case.
 */
import { parseGrantRegister } from "@libredb/grant-register";
import { type ServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { admittedFor, admittedManifest, packageRow, withLoosestClaims } from "./package-catalog";

/** The engine id of the package the catalog serves. */
export const STATEMENT_ROW_ENGINE = "acmestatementrow";

/** The catalog serving `STATEMENT_ROW_ENGINE` under its row, beside every legacy record. */
export function statementRowCatalog(): ServerCatalog {
  const pkg = admittedFor("acme-statement-row", admittedManifest(STATEMENT_ROW_ENGINE, withLoosestClaims));
  const row = packageRow(pkg, STATEMENT_ROW_ENGINE, {
    agentExecution: true,
    exposable: true,
    statementRead: true,
    statementLanguage: "sql",
    agentCredentialRequired: false,
    readRootsRequired: false,
    deniedFileAccessRefusal: null,
    singleWriterFile: true,
  });
  return composeServerCatalog([pkg], [], parseGrantRegister([row], LEGACY_ENGINE_IDS));
}
