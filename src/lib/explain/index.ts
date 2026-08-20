import type { ExplainFormat } from "@/lib/db/types";
import type { ExplainPlanInput, ExplainStrategy, StoredExplainPlan } from "./types";
import { postgresJsonStrategy } from "./postgres-json";
import { mysqlJsonStrategy } from "./mysql-json";
import { sqliteQueryplanStrategy } from "./sqlite-queryplan";
import { couchbaseJsonStrategy } from "./couchbase-json";
import { clickhouseJsonStrategy } from "./clickhouse-json";
import { druidNativeStrategy } from "./druid-native";
import { trinoJsonStrategy } from "./trino-json";

export type { ExplainMode, ExplainStrategy } from "./types";
export type { ExplainPlanInput } from "./types";

// Exhaustive by construction: adding an ExplainFormat member without a
// registry entry is a compile error.
const registry: Record<ExplainFormat, ExplainStrategy> = {
  "postgres-json": postgresJsonStrategy,
  "mysql-json": mysqlJsonStrategy,
  "sqlite-queryplan": sqliteQueryplanStrategy,
  "couchbase-json": couchbaseJsonStrategy,
  "clickhouse-json": clickhouseJsonStrategy,
  "druid-native": druidNativeStrategy,
  "trino-json": trinoJsonStrategy,
};

export function getExplainStrategy(format: ExplainFormat | undefined): ExplainStrategy | null {
  return format ? registry[format] : null;
}

function isStoredExplainPlan(value: unknown): value is StoredExplainPlan {
  if (typeof value !== "object" || value === null || !("raw" in value)) return false;
  const format = (value as { format?: unknown }).format;
  return typeof format === "string" && Object.hasOwn(registry, format);
}

/** Render boundary: QueryTab.explainPlan (unknown) -> tagged render model. Tolerates legacy raw postgres arrays. */
export function resolveExplainPlan(value: unknown): ExplainPlanInput | null {
  if (isStoredExplainPlan(value)) return registry[value.format].toRenderModel(value.raw);
  if (Array.isArray(value)) return postgresJsonStrategy.toRenderModel(value);
  return null;
}
