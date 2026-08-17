/**
 * The word an engine's schema inventory rows go by, in the run's own prose (#414).
 *
 * Its own module because two renderers need it — `context-snapshot.ts` writes the
 * inventory blocks and `er-diagram.ts` writes the relations block — and the first
 * imports the tool layer while the second imports nothing at all. Putting the noun in
 * either would drag one module's dependency graph into the other's for a sixteen-line
 * value.
 */

import type { ProviderLabels } from "@/lib/db/types";

/**
 * The word this engine's inventory rows go by, in the run's own prose.
 *
 * Every block a run was shown said "table(s)" until #414's live drive, on every
 * engine, because `TableSchema` is the one shape this product records a schema in. It
 * is a shape, not a claim about the world, and using it as a noun in a PROMPT made a
 * claim: a run told "Schema inventory for this run — 17 table(s)" over a Redis
 * keyspace drafted `KEYS user:*` and `ZCARD user:*`, naming a row as though a command
 * could be given it. The model was reading the sentence correctly.
 *
 * The product already knew the right word and only the UI was being told it.
 * `ProviderLabels.entityName` is "Table" on every SQL engine, "Collection" on MongoDB
 * and Couchbase, "Datasource" on Druid, "Key Pattern" on Redis and "Key Prefix" on
 * LibreDB — declared by the provider, which is where `CLAUDE.md` says engine
 * behaviour belongs. So this reads the label rather than the connection's type, and
 * an engine added later arrives with its own noun instead of being spelled "table"
 * until somebody notices.
 *
 * Lower-cased because the labels are written for buttons and headings and these
 * sentences are prose. The plural is carried rather than derived: "Key Prefixes" is
 * not "key prefix" plus an s in general, and a provider is free to declare a noun
 * this file has no business inflecting.
 */
export interface AgentInventoryNoun {
  /** "table", "key pattern" — used as `${count} ${singular}(s)`. */
  readonly singular: string;
  /** "tables", "key prefixes" — used where a sentence names them as a group. */
  readonly plural: string;
}

/**
 * What every SQL engine answers, and what a caller that has no labels to hand gets.
 *
 * It is the base provider's own label, so the default here and the default there are
 * one decision recorded twice rather than two that could drift apart: a caller that
 * passes nothing produces the identical prompt it produced before #414, byte for byte,
 * which is what keeps a PostgreSQL run's prompt unchanged by this work.
 */
export const TABLE_INVENTORY_NOUN: AgentInventoryNoun = Object.freeze({ singular: "table", plural: "tables" });

/** The noun a provider's labels declare. */
export function inventoryNoun(labels: ProviderLabels): AgentInventoryNoun {
  return { singular: labels.entityName.toLowerCase(), plural: labels.entityNamePlural.toLowerCase() };
}
