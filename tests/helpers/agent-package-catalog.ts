/**
 * A server catalog for the agent routes' tests of a provider package's engine, built in memory
 * (tests/helpers/package-catalog.ts): Studio's own engines beside four package engines, each the SDK's minimal manifest
 * with its id replaced, admitted and granted a register row only where named below.
 *
 * - `BARE`: the minimal manifest, no row: it requests no statement language and offers agent mode no reading.
 * - `REQUESTING`: the loosest claims, so it requests `sql`, and no row: not reviewed, and no reading.
 * - `READING`: the loosest claims, its row granting the `health` reading and no language.
 * - `EXECUTING`: the loosest claims, its row granting `sql` and agent execution and no reading, and reviewing no grammar
 *   (the row's `grammarSha256` is null while the manifest states SQL text).
 *
 * `agentPackageLanguageCatalog` is Studio's engines beside one more package engine, `AGENT_PACKAGE_LANGUAGE`, whose
 * declaration states the crafted language `acmeread` (tests/helpers/declared-agent-language.ts) and requests it with the
 * `health` reading, its row granting that language under the digest of the data it declares, agent execution and the
 * reading.
 *
 * No file is written and no package is imported; ids are fixture ids no bundled engine serves.
 */
import { parseGrantRegister } from "@libredb/grant-register";
import type { ServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { acmereadData } from "./declared-agent-language";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  packageRow,
  withLoosestClaims,
  withStatementLanguageData,
} from "./package-catalog";

export const AGENT_PACKAGE_ENGINES = Object.freeze({
  BARE: "acmeagentbare",
  REQUESTING: "acmeagentrequesting",
  READING: "acmeagentreading",
  EXECUTING: "acmeagentexecuting",
} as const);

/** The catalog of Studio's engines and the four package engines of `AGENT_PACKAGE_ENGINES`. */
export function agentPackageCatalog(): ServerCatalog {
  const { BARE, REQUESTING, READING, EXECUTING } = AGENT_PACKAGE_ENGINES;
  const bare = admittedFor("acme-agent-bare", admittedManifest(BARE));
  const requesting = admittedFor("acme-agent-requesting", admittedManifest(REQUESTING, withLoosestClaims));
  const reading = admittedFor("acme-agent-reading", admittedManifest(READING, withLoosestClaims));
  const executing = admittedFor("acme-agent-executing", admittedManifest(EXECUTING, withLoosestClaims));
  const register = parseGrantRegister(
    [
      packageRow(reading, READING, { agentReadings: Object.freeze(["health"] as const) }),
      packageRow(executing, EXECUTING, { statementLanguage: "sql", agentExecution: true }),
    ],
    LEGACY_ENGINE_IDS,
  );
  return composeServerCatalog([bare, requesting, reading, executing], [], register);
}

/** The package engine of `agentPackageLanguageCatalog`, granted its own declared language `acmeread`. */
export const AGENT_PACKAGE_LANGUAGE = "acmeagentlanguage";

/** The catalog of Studio's engines and `AGENT_PACKAGE_LANGUAGE`, its row granting its own declared language. */
export function agentPackageLanguageCatalog(): ServerCatalog {
  const data = acmereadData();
  const manifest = admittedManifest(AGENT_PACKAGE_LANGUAGE, (declared) => {
    declared.agent = { statementLanguage: data.name, overlay: { dialect: null, grounding: null } };
    declared.facets = { ...declared.facets, agentReadings: ["health"] };
    withStatementLanguageData(declared, data);
  });
  const spoken = admittedFor("acme-agent-language", manifest);
  const register = parseGrantRegister(
    [
      packageRow(spoken, AGENT_PACKAGE_LANGUAGE, {
        statementLanguage: data.name,
        languageSha256: declaredLanguageSha256(manifest),
        agentExecution: true,
        agentReadings: Object.freeze(["health"] as const),
      }),
    ],
    LEGACY_ENGINE_IDS,
  );
  return composeServerCatalog([spoken], [], register);
}
