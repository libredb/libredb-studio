import type { ExportSpec } from "@/lib/db/sql-writing/types";
import { snowflakeVectorDeclaration } from "./typed-literals";

/**
 * A Snowflake `VECTOR` column's declaration from its first value, since the driver reports the bare `VECTOR` without
 * its element type and dimension; every other declared type is left to the bare-name completion. Studio's SQL writing
 * function table binds it to the `declareFromSample` the engine's declaration names (src/lib/db/sql-writing/index.ts,
 * `SQL_WRITING_FUNCTIONS`).
 */
export const SNOWFLAKE_DECLARE_FROM_SAMPLE: NonNullable<ExportSpec["declareFromSample"]> = (declared, sample) =>
  declared.trim().toUpperCase() === "VECTOR" ? snowflakeVectorDeclaration(sample) : undefined;
