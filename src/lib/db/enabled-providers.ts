/**
 * LIBREDB_ENABLED_PROVIDERS, the enabled-provider allowlist, read in one place for every reader: the provider factory,
 * which refuses a type the list leaves out before anything is built, loaded or dialled (`assertProviderEnabled`), and
 * the SQLite sample, which is neither seeded nor listed when the factory could never open it.
 */

import type { DatabaseType } from "@/lib/types";
import { DatabaseConfigError } from "./errors";
import { isDatabaseType } from "./type-id";

/**
 * What `LIBREDB_ENABLED_PROVIDERS` says: `every` when it is unset or blank, which enables every provider; `listed` with
 * the connection types it names, trimmed, with empty entries dropped and each type kept once in first-seen order; or
 * `refused` with the `DatabaseConfigError` that names why the value cannot be read, an entry that is not a connection
 * type id or a set value that lists none. The VS Code extension is the one channel that sets it, in its backend
 * process; the web app, Docker, Helm, npx and the desktop launchers leave it unset.
 */
export type EnabledProviders =
  | { readonly kind: "every" }
  | { readonly kind: "listed"; readonly types: readonly DatabaseType[] }
  | { readonly kind: "refused"; readonly error: DatabaseConfigError };

/** The allowlist as it stands, read on every call and never cached. */
export function readEnabledProviders(): EnabledProviders {
  const raw = process.env.LIBREDB_ENABLED_PROVIDERS;
  if (raw === undefined || raw.trim() === "") return { kind: "every" };
  const entries = [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
  if (entries.length === 0) {
    return {
      kind: "refused",
      error: new DatabaseConfigError(
        "LIBREDB_ENABLED_PROVIDERS is set but lists no connection type id. Leave it unset to enable every provider.",
      ),
    };
  }
  const unknown = entries.find((entry) => !isDatabaseType(entry));
  if (unknown !== undefined) {
    return {
      kind: "refused",
      error: new DatabaseConfigError(
        `LIBREDB_ENABLED_PROVIDERS names ${JSON.stringify(unknown)}, which is not a connection type id. List type ids such as postgres, separated by commas.`,
      ),
    };
  }
  return { kind: "listed", types: entries as DatabaseType[] };
}

/**
 * The connection types this server may open, or `null` when every provider is enabled (`readEnabledProviders`).
 *
 * @throws DatabaseConfigError naming the entry when an entry is not a connection type id, or when a set value lists none.
 */
export function enabledProviderTypes(): readonly DatabaseType[] | null {
  const enabled = readEnabledProviders();
  if (enabled.kind === "refused") throw enabled.error;
  return enabled.kind === "every" ? null : enabled.types;
}
