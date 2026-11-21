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
import { governanceEnabled } from "@/lib/governance/config";

export const SQLITE_SAMPLE_SEED_ID = "sqlite-embedded-sample";

/**
 * Default on; only the literal "false" disables. Server-side env. Off under governance whatever
 * the variable says (docs/GOVERNANCE.md), so a governance install neither seeds nor lists it.
 */
export function isSqliteSampleEnabled(): boolean {
  if (governanceEnabled()) return false;
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
 * The copy is switched to WAL journal mode before the rename publishes it.
 * The template is in rollback-journal mode, and every writable open runs
 * `PRAGMA journal_mode = WAL`. Two opens making that switch at once fail with
 * "database is locked" whatever the busy timeout: each holds a read lock when
 * it asks for the write lock the switch needs, and SQLite refuses that upgrade
 * instead of waiting. The first page load opens the sample from several routes
 * at once, so most of those opens failed; a file already in WAL mode has no
 * switch to make (docs/providers/sqlite.md, "PRAGMAs on connect"). The switch
 * is made here by the provider's own open sequence, once, on a temp file no
 * other connection can see yet; a template that is not a SQLite database is
 * refused by that open rather than published.
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
    await switchToWalJournal(tempPath);
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

/**
 * Open the private copy once with the SQLite provider, whose open switches a writable file to
 * WAL journal mode, and close it again. Imported lazily, as the LibreDB sample imports its
 * engine, so the routes that only list the sample do not load the provider.
 *
 * The close removes the `-wal` and `-shm` files beside the copy where SQLite does (Linux,
 * Windows, and every worker open, which runs node:sqlite); bun:sqlite on macOS keeps them
 * (docs/providers/sqlite.md, "PRAGMAs on connect"). Nothing was written in WAL mode, so they
 * hold no page, and they are removed here so no file named after the temp path is left behind.
 */
async function switchToWalJournal(tempPath: string): Promise<void> {
  const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
  const provider = new SQLiteProvider({
    id: `seed:${SQLITE_SAMPLE_SEED_ID}`,
    name: "Sample (Employees)",
    type: "sqlite",
    database: tempPath,
    createdAt: new Date(0),
  });
  try {
    await provider.connect();
  } finally {
    await provider.disconnect();
    await fs.promises.rm(`${tempPath}-wal`, { force: true });
    await fs.promises.rm(`${tempPath}-shm`, { force: true });
  }
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
    roles: ["admin"],
    createdAt: new Date(0),
  };
}
