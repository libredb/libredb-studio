import { readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider directories that serve more than one type-id, with the files each type-id reads (InfluxDB spec F1,
 * R28 SR2 14).
 *
 * CLAUDE.md's layout is one type-id per file or per directory, and two censuses lean on it: the container path shape
 * census attributes a caller file to the type-id its name or directory names, and the connection dialog's field
 * census reads a type's whole directory as that type's source. `timeseries/influxdb/` breaks both, by decision
 * (I2, I23): one directory, two classes, flat prefixed files. So the split is DECLARED here, once, for both censuses,
 * rather than inferred twice: `influxql-*` files are `influxdb`'s, `sql-*` files are `influxdb3`'s, and the
 * unprefixed connection layer is both. `tests/unit/helpers/provider-directory-map.test.ts` holds the table equal to
 * the directory on disk, so a new file is claimed the day it lands.
 *
 * `sql/search/` also serves two type-ids, and is absent on purpose: every file there serves both, which is the
 * one-directory reading the censuses already give it.
 */
export interface ProviderDirectoryEntry {
  /** A file name prefix and the one type-id whose files it marks. */
  readonly byPrefix: Readonly<Record<string, DatabaseType>>;
  /** The unprefixed files every type-id of the directory reads, by file name. */
  readonly shared: readonly string[];
}

/** Where provider directories live, which the table's keys are relative to. */
export const PROVIDERS_ROOT = path.resolve(import.meta.dir, "../../src/lib/db/providers");

export const PROVIDER_DIRECTORY_MAP: Readonly<Record<string, ProviderDirectoryEntry>> = Object.freeze({
  "timeseries/influxdb": Object.freeze({
    byPrefix: Object.freeze({ "influxql-": "influxdb", "sql-": "influxdb3" }),
    shared: Object.freeze([
      "client.ts",
      "connection-options.ts",
      "errors.ts",
      "index.ts",
      "labels.ts",
      "monitoring.ts",
      "routes.ts",
      "run-database.ts",
      "versions.ts",
    ]),
  }),
});

/** The table's key for a directory, or undefined for a directory outside the providers root or not in the table. */
function entryKey(directory: string): string | undefined {
  const key = path.relative(PROVIDERS_ROOT, directory).split(path.sep).join("/");
  return Object.hasOwn(PROVIDER_DIRECTORY_MAP, key) ? key : undefined;
}

/** Every type-id a directory entry serves, in the order its prefixes are declared. */
function typeIdsOf(entry: ProviderDirectoryEntry): DatabaseType[] {
  return Object.values(entry.byPrefix);
}

/**
 * The type-ids a provider file serves, or null when its directory serves one type-id and the table has no say.
 *
 * A file in a mapped directory that is neither prefixed nor declared shared throws, naming it: attributing it to
 * nobody would let its reads vanish from both censuses.
 */
export function typeIdsOfProviderFile(file: string): readonly DatabaseType[] | null {
  const key = entryKey(path.dirname(file));
  if (key === undefined) return null;
  const entry = PROVIDER_DIRECTORY_MAP[key];
  const name = path.basename(file);
  if (entry.shared.includes(name)) return typeIdsOf(entry);
  const prefix = Object.keys(entry.byPrefix).find((candidate) => name.startsWith(candidate));
  if (prefix === undefined) {
    throw new Error(`${key}/${name} is neither a prefixed nor a declared shared file of its directory`);
  }
  return [entry.byPrefix[prefix]];
}

/**
 * The absolute paths of the `.ts` files in `directory` that `type` reads: its prefixed files and the shared ones.
 * Null for a directory the table does not map, which the caller reads whole; a type the directory does not serve
 * throws, naming both.
 */
export function providerDirectoryFiles(directory: string, type: DatabaseType): readonly string[] | null {
  const key = entryKey(directory);
  if (key === undefined) return null;
  if (!typeIdsOf(PROVIDER_DIRECTORY_MAP[key]).includes(type)) throw new Error(`${key} serves no ${type} files`);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(directory, name))
    .filter((file) => typeIdsOfProviderFile(file)?.includes(type));
}
