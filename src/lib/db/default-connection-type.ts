import type { DatabaseType } from "@/lib/types";

/**
 * The product's default engine: the one a new connection opens on, the connection picker's first, and the one a view
 * with no connection open names, as its explain request engine and its migration DDL header. Named once here, in a
 * module that imports nothing at run time, so every one of those readers names this constant rather than a type id.
 */
export const DEFAULT_CONNECTION_TYPE: DatabaseType = "postgres";
