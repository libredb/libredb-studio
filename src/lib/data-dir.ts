/**
 * Server-side data directory resolution. The data dir is wherever the SQLite
 * storage DB lives (writable in Docker as /app/data); the sample .libredb file
 * and generated auth credentials live alongside it. Launchers (npx/brew/deb)
 * point STORAGE_SQLITE_PATH at a platform-appropriate location.
 */
import * as path from "path";

export const DEFAULT_STORAGE_SQLITE_PATH = "./data/libredb-storage.db";

export function getDataDir(): string {
  return path.dirname(process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH);
}
