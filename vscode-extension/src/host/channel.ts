import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/**
 * The external engines the VS Code channel does not offer yet, each with the reason, a policy default held by the
 * guard's `REGISTRIES`. Every other external engine is enabled, so a new type id joins the extension unless it is
 * listed here, and the README test fails until the Marketplace README names it.
 */
export const HELD_BACK: Readonly<Partial<Record<DatabaseType, string>>> = Object.freeze({
  oracle: "oracledb is a child external, and the VSIX is packed without dependencies.",
  duckdb: "@duckdb/node-api is a native addon per platform, and the VSIX is packed without dependencies.",
  db2: "db2-node is a native addon per platform, and the VSIX is packed without dependencies.",
});

function isHeldBack(type: DatabaseType): boolean {
  return Object.hasOwn(HELD_BACK, type);
}

/**
 * The type ids the VS Code channel lets the child load (`LIBREDB_ENABLED_PROVIDERS`): the external engines less
 * HELD_BACK. The host reads them from compatibility.ts, since connection-form.ts would bundle provider modules.
 */
export const ENABLED_PROVIDERS: readonly DatabaseType[] = EXTERNAL_DATABASE_TYPES.filter((type) => !isHeldBack(type));
