/**
 * One object as a CONSUMER reads it: its identity from `DatabaseObject` and its content
 * from `ObjectDetail`, in one record (#789).
 *
 * The components that draw columns need both halves at once. `DatabaseObject` names an
 * object and says what KIND it is; `ObjectDetail` carries the columns, indexes and foreign
 * keys of one object. A diagram, a documentation page and a code generator all need the
 * two together, so this is the shape they take rather than a pair of props a caller could
 * mismatch.
 *
 * `kind` and `path` are OPTIONAL, and that is the same transitional decision Task 24 made
 * for `AgentInventoryObject`, for the same measured reason: an entry that reached a
 * consumer through the flat schema surface has a qualified NAME and no kind and no
 * segments, and no reader may split that name to invent them. A table literally called
 * `a.b` in `public` is why. Absent means the object surface did not answer for this entry,
 * and absent is never filled in with the most common value: a filter below refuses to
 * narrow a population nothing declared anything about, rather than guessing "table".
 *
 * Task 26 removes the flat surface, at which point both fields become facts every entry
 * carries and the `?` can go.
 */
import { resolveObjectAddress } from "@/lib/db/object-address";
import { findKind, kindAcceptsRowWrites } from "@/lib/db/object-kinds";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema, ForeignKeySchema, IndexSchema } from "@/lib/types";

export interface DetailedObject {
  /** The display label, which is NOT required to equal the last path segment. */
  readonly name: string;
  /** The declared kind id this object was listed under, when one is known. */
  readonly kind?: string;
  /** The object's segments, when the object surface supplied them. Never split from `name`. */
  readonly path?: readonly string[];
  readonly columns: readonly ColumnSchema[];
  readonly indexes: readonly IndexSchema[];
  readonly foreignKeys?: readonly ForeignKeySchema[];
  /** Only where the engine counts. */
  readonly rowCount?: number;
  /** The engine's own rendering of the object's size, where it publishes one. */
  readonly size?: string;
}

/**
 * The objects a relation-shaped consumer may render.
 *
 * The gate is the declared ROLE and never the kind id, which is the whole of this task's
 * rule: a consumer that lists rows, diagrams foreign keys or documents columns wants
 * anything the provider declared `role: "relation"`, on every engine, including kinds this
 * repo has never heard of. A routine, a trigger and a ClickHouse dictionary are refused by
 * the same one line, so a new engine needs no change here.
 *
 * Two absences are kept rather than refused, and they are different from each other:
 * capabilities that have not loaded yet is a consumer rendering before
 * `useProviderMetadata` answered, and an object with no `kind` came through the flat
 * surface that declares none. In both cases nothing has said this object is not a
 * relation, and hiding an object because a declaration had not arrived is a worse failure
 * than showing one: it looks like the database does not hold it.
 *
 * An object carrying a kind the provider does NOT declare is refused, because a kind with
 * no declaration is exactly what the tree draws no folder for (standing ruling 4).
 */
export function relationObjects(
  objects: readonly DetailedObject[],
  capabilities: ProviderCapabilities | undefined,
): readonly DetailedObject[] {
  if (capabilities === undefined) return objects;
  return objects.filter(
    (object) => object.kind === undefined || findKind(capabilities, object.kind)?.role === "relation",
  );
}

/**
 * The objects an import or a row write may target.
 *
 * `kindAcceptsRowWrites` and nothing else, which standing ruling 4 is explicit about: the
 * engine-wide `supportsInlineRowEdit` is a SEPARATE fact about the results grid's inline
 * editor, and MongoDB, Couchbase and Cassandra declare it false while declaring a kind
 * that genuinely takes row writes. Conjoining the two here would refuse an import all
 * three engines support today. The conjunction belongs at the one caller that needs both
 * facts, `src/components/object-tree/row-actions.ts`, spelled out there.
 *
 * A view is the case this exists for: it has columns, it is a relation, and on most
 * engines an insert into it is meaningless, so only the provider's own
 * `acceptsRowWrites` can tell it apart from a table.
 */
export function rowWritableObjects(
  objects: readonly DetailedObject[],
  capabilities: ProviderCapabilities | undefined,
): readonly DetailedObject[] {
  if (capabilities === undefined) return objects;
  return objects.filter((object) => object.kind === undefined || kindAcceptsRowWrites(capabilities, object.kind));
}

/**
 * The flat reading of a database, tagged with the kind and the segments the OBJECT surface
 * answered for the same objects (#789).
 *
 * TWO READINGS ARE JOINED HERE and neither can be dropped, for the same reason
 * `tagWithObjectKinds` in the agent's context snapshot joins the same two: the flat
 * surface carries columns, indexes and foreign keys and says nothing about kind, while
 * the object surface carries kind and segments and no columns, because reading columns in
 * bulk is the N+1 the inventory route refused. A consumer needs both halves at once, so
 * the hook asks for both and this puts them in one record.
 *
 * THE JOIN KEY IS THE NAME, resolved against the address by `resolveObjectAddress` rather
 * than compared to it, because the flat reading qualifies a name only as far as the engine's
 * own display rule does: on PostgreSQL a table in `public` arrives as `users` while its
 * object is `["public", "users"]`, and on Trino EVERY name arrives as `schema.table` against
 * a `[catalog, schema, table]` path. This was first written as two comparisons, the whole
 * path joined by `.` and the last segment alone, which are the only two spellings a
 * one-level engine has and are not the spelling any two-level engine writes: no object on
 * Trino joined at all, and SQL Server, DuckDB and Couchbase joined only inside their default
 * container, so every filter above was inert over those populations.
 *
 * That rule lives in `object-address.ts` and not here, because the agent's ER diagram and
 * its own inventory join resolve the same class of spelling and the three must not come to
 * disagree about what a name means.
 *
 * AMBIGUITY REFUSES TO GUESS. Where two objects claim one name at the same length, the entry
 * is returned
 * untagged, because nothing in the flat reading records which container built it and
 * filing a `sales` view under `public` as a table is worse than knowing nothing: an entry
 * with no kind is kept by every filter above, and a wrongly kinded one is hidden or
 * offered for a write.
 *
 * THE FLAT LIST IS THE POPULATION. An object the flat reading never named is NOT added
 * here, which is the one place this deliberately does less than the agent's join. The
 * agent packs a prompt, where a duplicate costs tokens; these entries are ROWS, and an
 * object whose name did not join would appear beside the flat entry it failed to match as
 * a second row for one table. Task 26 removes the flat reading entirely, at which point
 * the object surface is the population and there is nothing left to join.
 */
export function tagObjectKinds(
  flat: readonly DetailedObject[],
  objects: readonly DatabaseObject[],
): readonly DetailedObject[] {
  return flat.map((entry) => {
    const resolution = resolveObjectAddress(objects, (object) => object.path, entry.name);
    if (resolution.kind !== "resolved") return entry;
    return { ...entry, kind: resolution.object.kind, path: resolution.object.path };
  });
}
