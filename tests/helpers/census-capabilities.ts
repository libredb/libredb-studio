/**
 * Every shipped engine's capabilities as its provider declares them before it connects, the census's read: each
 * provider built once through `createDatabaseProvider` with the engine's census connection (./census-connection.ts).
 *
 * The read runs in a child process, this module run as a script, with `CAPABILITY_READ_ENVIRONMENT` as its whole
 * environment and no `.env` file loaded, the environment the engine declaration generator reads capabilities in
 * (scripts/generate-engine-declarations.ts). A provider reads variables when it is built and some change what it
 * declares (the Firestore provider declares no explain format when `FIRESTORE_EMULATOR_HOST` is set), so a variable set
 * where the tests run changes neither the declarations nor the census that reads them back.
 *
 * The generator's child reads through `readProviderDeclarations` and this one through `createDatabaseProvider`, so the
 * two reads share the connection record, the environment and the JSON round trip check, `refuseInexactJson`, which
 * makes a capability JSON cannot carry exactly a thrown error naming the engine.
 *
 * Run as a script: bun --no-env-file tests/helpers/census-capabilities.ts <file>
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAPABILITY_READ_ENVIRONMENT } from "../../scripts/generate-engine-declarations";
import { refuseInexactJson } from "../../scripts/read-engine-capabilities";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "./census-connection";

const ROOT = path.resolve(import.meta.dir, "../..");

/**
 * Every shipped engine's capabilities, read by this module in a child process. A child that fails rejects the read
 * with its exit code, after its own error, which it writes to this process's output.
 */
export async function readCensusCapabilities(): Promise<Readonly<Record<DatabaseType, ProviderCapabilities>>> {
  const directory = mkdtempSync(path.join(tmpdir(), "census-capabilities-"));
  try {
    const file = path.join(directory, "capabilities.json");
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, file], {
      cwd: ROOT,
      env: { ...CAPABILITY_READ_ENVIRONMENT },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`the census's capability read exited with code ${exitCode}`);
    // The child writes one entry per member of SHIPPED_DATABASE_TYPES, which lists every member of DatabaseType.
    return Object.freeze(JSON.parse(readFileSync(file, "utf8")) as Record<DatabaseType, ProviderCapabilities>);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  const read = await Promise.all(
    SHIPPED_DATABASE_TYPES.map(async (type) => {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      refuseInexactJson(type, capabilities);
      return [type, capabilities] as const;
    }),
  );
  writeFileSync(file, JSON.stringify(Object.fromEntries(read)));
}
