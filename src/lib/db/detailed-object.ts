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
import { findKind, kindAcceptsRowWrites } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";
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
