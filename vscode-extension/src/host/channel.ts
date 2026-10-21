import type { DatabaseType } from "@/lib/types";

/**
 * The type ids the VS Code channel lets the child load (`LIBREDB_ENABLED_PROVIDERS`), a policy default held by the
 * guard's `REGISTRIES`.
 */
export const ENABLED_PROVIDERS: readonly DatabaseType[] = ["postgres", "mssql", "mysql", "mongodb"];
