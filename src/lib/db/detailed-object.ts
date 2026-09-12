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
 * `kind` and `path` are FACTS on every entry, which they were not while the flat schema
 * reading still existed: an entry that reached a consumer through that reading had a
 * qualified name and no segments, and no reader was allowed to split the name to invent
 * them. The flat reading is gone, every entry now comes from the object surface, and a
 * consumer filter that had to keep an unlabelled object rather than hide it has nothing
 * left to keep. `StoredObject` below is the one shape that still has the absences, and it
 * is persisted data rather than a reading.
 */
import { findKind, kindAcceptsRowWrites } from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type { DatabaseObject, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import type { ColumnSchema, ForeignKeySchema, IndexSchema } from "@/lib/types";

export interface DetailedObject {
  /** The display label, which is NOT required to equal the last path segment. */
  readonly name: string;
  /** The declared kind id this object was listed under. */
  readonly kind: string;
  /** The object's segments, as the object surface addressed it. Never split from `name`. */
  readonly path: readonly string[];
  readonly columns: readonly ColumnSchema[];
  readonly indexes: readonly IndexSchema[];
  readonly foreignKeys?: readonly ForeignKeySchema[];
  /** Only where the engine counts. */
  readonly rowCount?: number;
  /** The engine's own rendering of the object's size, where it publishes one. */
  readonly size?: string;
}

/**
 * What a PERSISTED object record may hold, which is not the same as what a reading holds.
 *
 * `SchemaSnapshot.schema` is written to the user's own storage and read back months later,
 * and a record written before the object model landed carries neither `kind` nor `path`.
 * Those records are not migrated and do not need to be: `diffSchemas` compares BY NAME, so
 * an old snapshot diffs against a current reading with nothing reported as removed and
 * re-added, which is the measured reason Task 25c kept the comparison on the name.
 *
 * Declaring the stored array as `DetailedObject` would be the drift that field has already
 * had once, where the declaration said `TableSchema` while the stored JSON carried two more
 * fields and a later reader trusted the type instead of the data. So the live shape states
 * what a reading always has, and this one states what storage may lack.
 */
export type StoredObject = Omit<DetailedObject, "kind" | "path"> & {
  readonly kind?: string;
  readonly path?: readonly string[];
};

/**
 * The objects a relation-shaped consumer may render.
 *
 * The gate is the declared ROLE and never the kind id, which is the whole of this rule: a
 * consumer that lists rows, diagrams foreign keys or documents columns wants anything the
 * provider declared `role: "relation"`, on every engine, including kinds this repo has
 * never heard of. A routine, a trigger and a ClickHouse dictionary are refused by the same
 * one line, so a new engine needs no change here.
 *
 * Capabilities that have not loaded yet is the one absence kept rather than refused: a
 * consumer can render before `useProviderMetadata` has answered, nothing has said these
 * objects are not relations, and hiding an object because a declaration had not arrived is
 * a worse failure than showing one, because it looks like the database does not hold it.
 *
 * An object carrying a kind the provider does NOT declare is refused, because a kind with
 * no declaration is exactly what the tree draws no folder for (standing ruling 4).
 */
export function relationObjects(
  objects: readonly DetailedObject[],
  capabilities: ProviderCapabilities | undefined,
): readonly DetailedObject[] {
  if (capabilities === undefined) return objects;
  return objects.filter((object) => findKind(capabilities, object.kind)?.role === "relation");
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
  return objects.filter((object) => kindAcceptsRowWrites(capabilities, object.kind));
}

/**
 * The objects an inventory read named, joined to the columns it described (#789).
 *
 * THE JOIN KEY IS THE PATH, segment by segment, and that is the whole point of this function
 * existing rather than a name comparison: both halves come from the same provider call for the
 * same container and kind, so the address is exact on both sides and no reader has to split a
 * name to find it. Every dot-splitting defect this epic fixed came from a name standing in for
 * an address, and this is the join where that used to happen.
 *
 * An object with no matching detail keeps EMPTY columns rather than being dropped. Two states
 * reach that arm and both are true readings: a kind that legitimately has no columns, and a read
 * the inventory bounded before it could describe that folder. Dropping the object would turn
 * either into "this database does not hold it", which is the absence #414 measured.
 */
export function detailedObjects(
  objects: readonly DatabaseObject[],
  details: readonly ObjectDetail[],
): readonly DetailedObject[] {
  const byPath = new Map(details.map((detail) => [pathKey(detail.path), detail]));
  return objects.map((object) => {
    const detail = byPath.get(pathKey(object.path));
    return {
      name: object.name,
      kind: object.kind,
      path: object.path,
      columns: detail?.columns ?? [],
      indexes: detail?.indexes ?? [],
      foreignKeys: detail?.foreignKeys ?? [],
      ...(object.rowCount === undefined ? {} : { rowCount: object.rowCount }),
      ...(object.sizeBytes === undefined ? {} : { size: formatBytes(object.sizeBytes) }),
    };
  });
}
