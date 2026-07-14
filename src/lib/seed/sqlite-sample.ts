/**
 * The built-in "Sample (Employees)" SQLite connection and its seed file.
 *
 * On standalone startup (see instrumentation.ts) the vendored template
 * seed-assets/sqlite/employee.db is copied — asynchronously and fail-open —
 * into the data dir as sample-employees.db; getManagedConnections() then
 * advertises an editable, dismissable sqlite connection pointing at it.
 * None of this is in the published @libredb/studio surface, so platform is
 * unaffected: instrumentation never runs there, the file never exists, and
 * the seed state below stays "idle".
 *
 * The template ships inside every distribution payload as a top-level
 * seed-assets/ dir; process.cwd() is the payload root in every channel
 * because Next's standalone server.js chdirs into its own directory.
 */
import * as fs from "fs";
import * as path from "path";
import type { ManagedConnection } from "./types";
import { getDataDir } from "@/lib/data-dir";

export const SQLITE_SAMPLE_SEED_ID = "sqlite-embedded-sample";

/** Default on; only the literal "false" disables. Server-side env. */
export function isSqliteSampleEnabled(): boolean {
  return process.env.SQLITE_EMBEDDED_SAMPLE !== "false";
}

/** Override via SQLITE_EMBEDDED_SAMPLE_PATH, else `<data dir>/sample-employees.db`,
 * where the data dir mirrors the SQLite storage location (writable in Docker). */
export function resolveSqliteSamplePath(): string {
  const override = process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
  if (override) return override;
  return path.join(getDataDir(), "sample-employees.db");
}

/** The read-only vendored template. Override via SQLITE_EMBEDDED_SAMPLE_TEMPLATE
 * (tests, exotic packaging layouts); the default is cwd-relative because every
 * channel runs server.js from the payload root where seed-assets/ ships. */
export function resolveSqliteSampleTemplatePath(): string {
  const override = process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE;
  if (override) return override;
  return path.join(process.cwd(), "seed-assets", "sqlite", "employee.db");
}

/**
 * Async seed lifecycle marker, shared between instrumentation.ts (writer) and
 * the managed-connections API (reader) so clients know to poll while the copy
 * is in flight. Stored on globalThis because Next.js bundles instrumentation
 * and each route handler separately — a module-level variable would not be
 * shared across those bundles, a global keyed by Symbol.for is.
 */
export type SqliteSampleSeedState = "idle" | "seeding" | "done" | "failed";

const SEED_STATE_KEY = Symbol.for("libredb-studio.sqlite-sample-seed-state");

type SeedStateHolder = { [SEED_STATE_KEY]?: SqliteSampleSeedState };

export function setSqliteSampleSeedState(state: SqliteSampleSeedState): void {
  (globalThis as SeedStateHolder)[SEED_STATE_KEY] = state;
}

export function getSqliteSampleSeedState(): SqliteSampleSeedState {
  return (globalThis as SeedStateHolder)[SEED_STATE_KEY] ?? "idle";
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the vendored template to the runtime sample path. Idempotent: if the
 * file already exists it is left untouched (never clobber the user's edits)
 * and "skipped" is returned so the caller can keep fast-path boots quiet.
 * Copies into a per-process temp file first, then atomically renames it into
 * place — a partial file is never published (getManagedConnections would
 * otherwise advertise a broken sample because the path exists), and
 * concurrent workers each publish one complete file (last writer wins; both
 * copies are identical).
 *
 * Genuinely asynchronous (fs.promises throughout): instrumentation.ts
 * fire-and-forgets this, and only real await points make that true — with
 * sync fs calls the whole copy would run before the IIFE's first suspension,
 * blocking boot and making the "seeding" state unobservable.
 */
export async function seedSqliteSampleFile(filePath: string): Promise<"seeded" | "skipped"> {
  if (await fileExists(filePath)) return "skipped"; // a complete file is already present

  const templatePath = resolveSqliteSampleTemplatePath();
  if (!(await fileExists(templatePath))) {
    throw new Error(`SQLite sample template not found: ${templatePath}`);
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  // The temp name is per-pid; on entry any existing temp with our pid is a
  // leftover from a crashed boot (Docker restarts often reuse pid 1) and is
  // stale by construction — discard it before copying.
  const tempPath = `${filePath}.${process.pid}.seeding`;
  await fs.promises.rm(tempPath, { force: true });

  try {
    await fs.promises.copyFile(templatePath, tempPath);
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (renameError) {
      // Another worker won the race and created filePath first. POSIX rename
      // overwrites, but Windows throws if the destination exists — treat a
      // present destination as success (the sample is seeded), and only
      // rethrow if filePath still does not exist.
      await fs.promises.rm(tempPath, { force: true });
      if (!(await fileExists(filePath))) throw renameError;
    }
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }); // never leave a partial temp behind
    throw error;
  }
  return "seeded";
}

/** The built-in editable seed connection descriptor (managed:false). */
export function buildSqliteSampleConnection(): ManagedConnection {
  return {
    id: `seed:${SQLITE_SAMPLE_SEED_ID}`,
    seedId: SQLITE_SAMPLE_SEED_ID,
    name: "Sample (Employees)",
    type: "sqlite",
    database: resolveSqliteSamplePath(),
    managed: false,
    roles: ["*"],
    createdAt: new Date(0),
  };
}
