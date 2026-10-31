/**
 * Which entries of a run's inventory a consumer may treat as something a statement can
 * NAME (#789).
 *
 * The inventory a run reasons over stopped being a list of tables when the object surface
 * landed: a PostgreSQL capture now carries its views, its sequences and its functions
 * beside its tables, each under the kind the engine declared it. Every consumer below this
 * that speaks the word "table" therefore has to say which of those it means, and the
 * answer is the DECLARED ROLE and never a kind id and never the database type id. A kind
 * this repository has never heard of - a TimescaleDB hypertable, a Druid datasource - is
 * admitted because the provider declared `role: "relation"` for it, and a sequence is
 * refused on the same one line, so a new engine needs no change here.
 *
 * Two absences are KEPT rather than refused, for the reason `src/lib/db/detailed-object.ts`
 * states about the component side of the same migration: an inventory recorded before
 * kinds existed declares none, and an entry that reached a run through the flat schema
 * reading has a qualified NAME and no kind. Nothing has said either is not a relation, and
 * dropping an object because a declaration never arrived reads to a model as a database
 * that does not hold it. An object carrying a kind the inventory declares NOTHING about is
 * the other way round and is refused: a kind with no declaration is exactly what the tree
 * draws no folder for (standing ruling 4 of #789).
 *
 * A DERIVED GROUPING is refused although its role is `relation`, and that is the one part
 * of this that is not a role test. `AgentInventoryKind.derivedGroupings` carries
 * `ProviderCapabilities.tablesAreDerivedGroupings`, which says the rows of that kind are
 * prefix groupings this server derived out of a bounded scan rather than objects anybody
 * named - Redis key patterns and LibreDB keyspaces - so no statement can be written
 * against one. #414 measured a run drafting a command against exactly such a row. The old
 * flat row menu withheld Generate Query and Profile whenever the flag was set, and this is
 * where that refusal is carried now that the flag's readers have moved to the object
 * model.
 */
import type { AgentInventory, AgentInventoryObject } from "./types";

export function addressableObjects(inventory: AgentInventory): readonly AgentInventoryObject[] {
  const addressable = new Set(
    (inventory.kinds ?? [])
      .filter((kind) => kind.role === "relation" && kind.derivedGroupings !== true)
      .map((kind) => kind.id),
  );
  return inventory.objects.filter((object) => object.kind === undefined || addressable.has(object.kind));
}

/**
 * The provider's reason where nothing of an inventory was listed because the connection lacks the configuration its
 * provider needs to list one (U189): no object, and every declared kind carrying the one `unavailable` sentence the
 * walk wrote from `DatabaseProvider.inventoryNeedsConfiguration`. `undefined` for every other inventory, an empty one
 * included, so "reported no tables" stays the answer where the engine was asked and answered none.
 *
 * Here rather than beside the packing because the rail reads it too, and this module imports nothing but types.
 */
export function unlistedInventoryReason(inventory: AgentInventory): string | undefined {
  const kinds = inventory.kinds ?? [];
  if (inventory.objects.length > 0 || kinds.length === 0) return undefined;
  const reason = kinds[0].unavailable;
  return kinds.every((kind) => kind.unavailable === reason) ? reason : undefined;
}
