import type { ExplainFormat } from "@/lib/db/types";
import type { ExplainStrategy } from "./types";
import { postgresJsonStrategy } from "./postgres-json";
import { mysqlJsonStrategy } from "./mysql-json";

export type { ExplainMode, ExplainStrategy } from "./types";

// Exhaustive by construction: adding an ExplainFormat member without a
// registry entry is a compile error.
const registry: Record<ExplainFormat, ExplainStrategy> = {
  "postgres-json": postgresJsonStrategy,
  "mysql-json": mysqlJsonStrategy,
};

export function getExplainStrategy(format: ExplainFormat | undefined): ExplainStrategy | null {
  return format ? registry[format] : null;
}
