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
 * No file is written and no package is imported; ids are fixture ids no bundled engine serves.
 */
import { parseGrantRegister } from "@libredb/grant-register";
import type { ServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { admittedFor, admittedManifest, packageRow, withLoosestClaims } from "./package-catalog";

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
