#!/usr/bin/env bun
/**
 * Writes every shipped engine's capabilities, as its provider declares them before it connects, to the JSON file its
 * one argument names: each provider built once with the engine's census connection (tests/helpers/census-connection.ts)
 * through `readProviderDeclarations`, the read Studio takes of a provider it never connects.
 *
 * `readEngineCapabilities` in scripts/generate-engine-declarations.ts runs this script as a child process in a stated
 * environment, with no variable of the environment it runs in and no `.env` file loaded, because a provider reads
 * variables when it is built and some change what it declares (the Firestore provider declares no explain format when
 * `FIRESTORE_EMULATOR_HOST` is set). So a committed declaration never depends on where the generator ran.
 *
 * The capabilities cross the process boundary as JSON, so each engine's is held to its own JSON round trip first, and
 * a capability JSON cannot carry exactly (a function, an undefined member, a class instance) is a thrown error naming
 * the engine, never a member dropped on the way.
 *
 * Run: bun --no-env-file scripts/read-engine-capabilities.ts <file>
 */
import { writeFileSync } from "node:fs";
import { SHIPPED_DATABASE_TYPES } from "../src/lib/db/compatibility";
import { readProviderDeclarations } from "../src/lib/db/factory";
import type { ProviderCapabilities } from "../src/lib/db/types";
import type { DatabaseType } from "../src/lib/types";
import { CENSUS_CONNECTION } from "../tests/helpers/census-connection";

/** Throws an error naming `type` when `capabilities` is not exactly what its JSON text reads back as. */
export function refuseInexactJson(type: DatabaseType, capabilities: ProviderCapabilities): void {
  if (!Bun.deepEquals(JSON.parse(JSON.stringify(capabilities)), capabilities, true)) {
    throw new Error(`${type}: the provider's capabilities hold a value JSON cannot carry exactly`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) {
    console.error("Usage: bun --no-env-file scripts/read-engine-capabilities.ts <file>");
    return 2;
  }
  const read = await Promise.all(
    SHIPPED_DATABASE_TYPES.map(async (type) => {
      const { capabilities } = await readProviderDeclarations(CENSUS_CONNECTION[type]);
      refuseInexactJson(type, capabilities);
      return [type, capabilities] as const;
    }),
  );
  writeFileSync(argv[0], JSON.stringify(Object.fromEntries(read)));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
