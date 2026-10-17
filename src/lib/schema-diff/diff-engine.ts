import type { ColumnSchema, IndexSchema, ForeignKeySchema } from "@/lib/types";
import type { StoredObject } from "@/lib/db/detailed-object";
import { objectPathLabel, pathKey } from "@/lib/db/object-path";
import type { SchemaDiff, TableDiff, ColumnDiff, IndexDiff, ForeignKeyDiff } from "./types";

function diffColumns(sourceCols: readonly ColumnSchema[], targetCols: readonly ColumnSchema[]): ColumnDiff[] {
  const diffs: ColumnDiff[] = [];
  const sourceMap = new Map(sourceCols.map((c) => [c.name, c]));
  const targetMap = new Map(targetCols.map((c) => [c.name, c]));

  // Added columns (in target but not in source)
  for (const [name, col] of targetMap) {
    if (!sourceMap.has(name)) {
      diffs.push({
        action: "added",
        columnName: name,
        targetType: col.type,
        targetNullable: col.nullable,
        targetDefault: col.defaultValue,
        targetDefaultSql: col.defaultExpression,
        targetIsPrimary: col.isPrimary,
        changes: [`Added column "${name}" (${col.type})`],
      });
    }
  }

  // Removed columns (in source but not in target)
  for (const [name, col] of sourceMap) {
    if (!targetMap.has(name)) {
      diffs.push({
        action: "removed",
        columnName: name,
        sourceType: col.type,
        sourceNullable: col.nullable,
        sourceDefault: col.defaultValue,
        sourceIsPrimary: col.isPrimary,
        changes: [`Removed column "${name}" (${col.type})`],
      });
    }
  }

  // Modified columns (in both, check for differences)
  for (const [name, sourceCol] of sourceMap) {
    const targetCol = targetMap.get(name);
    if (!targetCol) continue;

    const changes: string[] = [];

    if (sourceCol.type.toLowerCase() !== targetCol.type.toLowerCase()) {
      changes.push(`Type changed: ${sourceCol.type} → ${targetCol.type}`);
    }
    if (sourceCol.nullable !== targetCol.nullable) {
      changes.push(`Nullable changed: ${sourceCol.nullable} → ${targetCol.nullable}`);
    }
    // Compare the SQL TEXT where the provider gave one, which is the quantity the migration
    // generator emits, and fall back to the value where it did not. Presence, not truthiness:
    // MariaDB reports `DEFAULT ''` as the value "" with the expression "''", and a column
    // with no default at all as neither field, so a `||` fallback collapses the two onto the
    // same string and reports no change for a real difference, in both directions. Reading
    // the text first also makes a snapshot taken before the decoding, which stored the
    // catalog text in `defaultValue`, compare EQUAL to the same unchanged table read today.
    // One stale case it does NOT settle, measured and accepted rather than repaired: a
    // pre-decoding MariaDB snapshot stored the four-character keyword `NULL` for a column
    // with NO default, and today that column carries neither field, so such a snapshot
    // reports one "Default changed: NULL -> none" per no-default column and one MODIFY that
    // changes nothing. Reading the keyword as absence here would put back the very ambiguity
    // #795 removed, since `NULL` is also a value a column can really default to.
    // A second one, same verdict (#1031): a MySQL snapshot taken before SchemaDiff read the
    // DDL holds only the catalog's value, and today's reading carries the SQL text too, so it
    // reports "Default changed: abc -> 'abc'" for every default the server spells with quotes
    // or as an expression (string, date, enum, binary, expression). A bare number is the same
    // text on both sides. The old value cannot be told from SQL, which is the defect #1031
    // fixed, so nothing here can reconcile the two; a new snapshot clears it.
    const sourceDefault = sourceCol.defaultExpression ?? sourceCol.defaultValue;
    const targetDefault = targetCol.defaultExpression ?? targetCol.defaultValue;
    if (sourceDefault !== targetDefault) {
      changes.push(`Default changed: ${sourceDefault ?? "none"} → ${targetDefault ?? "none"}`);
    }
    if (sourceCol.isPrimary !== targetCol.isPrimary) {
      changes.push(`Primary key changed: ${sourceCol.isPrimary} → ${targetCol.isPrimary}`);
    }

    if (changes.length > 0) {
      diffs.push({
        action: "modified",
        columnName: name,
        sourceType: sourceCol.type,
        targetType: targetCol.type,
        sourceNullable: sourceCol.nullable,
        targetNullable: targetCol.nullable,
        sourceDefault: sourceCol.defaultValue,
        targetDefault: targetCol.defaultValue,
        targetDefaultSql: targetCol.defaultExpression,
        sourceIsPrimary: sourceCol.isPrimary,
        targetIsPrimary: targetCol.isPrimary,
        changes,
      });
    }
  }

  return diffs;
}

function diffIndexes(sourceIndexes: readonly IndexSchema[], targetIndexes: readonly IndexSchema[]): IndexDiff[] {
  const diffs: IndexDiff[] = [];

  // Build a stable map key from the column set. Copy before sorting so the
  // original column order is preserved for the diff messages below. Use the
  // default (code-point) sort, NOT localeCompare: this is an internal canonical
  // key for set matching, so it must be deterministic and locale-independent.
  // localeCompare would tie the key to the host locale. S2871 is suppressed for
  // this file in sonar-project.properties for exactly this reason.
  const columnKey = (idx: IndexSchema) => idx.name || [...idx.columns].sort().join(",");

  const sourceMap = new Map<string, IndexSchema>();
  sourceIndexes.forEach((idx) => {
    sourceMap.set(columnKey(idx), idx);
  });

  const targetMap = new Map<string, IndexSchema>();
  targetIndexes.forEach((idx) => {
    targetMap.set(columnKey(idx), idx);
  });

  for (const [key, idx] of targetMap) {
    if (!sourceMap.has(key)) {
      diffs.push({
        action: "added",
        indexName: idx.name || key,
        targetColumns: idx.columns,
        targetUnique: idx.unique,
        changes: [`Added index "${idx.name || key}" on (${idx.columns.join(", ")})`],
      });
    }
  }

  for (const [key, idx] of sourceMap) {
    if (!targetMap.has(key)) {
      diffs.push({
        action: "removed",
        indexName: idx.name || key,
        sourceColumns: idx.columns,
        sourceUnique: idx.unique,
        changes: [`Removed index "${idx.name || key}"`],
      });
    }
  }

  for (const [key, sourceIdx] of sourceMap) {
    const targetIdx = targetMap.get(key);
    if (!targetIdx) continue;

    const changes: string[] = [];
    // Index columns are ordered: (a, b) and (b, a) have different leading keys.
    // Serialize the array instead of joining, so commas inside identifiers cannot
    // make distinct column lists compare equal. Neither input is mutated.
    if (JSON.stringify(sourceIdx.columns) !== JSON.stringify(targetIdx.columns)) {
      changes.push(`Columns changed: (${sourceIdx.columns.join(", ")}) → (${targetIdx.columns.join(", ")})`);
    }
    if (sourceIdx.unique !== targetIdx.unique) {
      changes.push(`Unique changed: ${sourceIdx.unique} → ${targetIdx.unique}`);
    }

    if (changes.length > 0) {
      diffs.push({
        action: "modified",
        indexName: sourceIdx.name || key,
        sourceColumns: sourceIdx.columns,
        targetColumns: targetIdx.columns,
        sourceUnique: sourceIdx.unique,
        targetUnique: targetIdx.unique,
        changes,
      });
    }
  }

  return diffs;
}

function diffForeignKeys(
  sourceFKs: readonly ForeignKeySchema[],
  targetFKs: readonly ForeignKeySchema[],
): ForeignKeyDiff[] {
  const diffs: ForeignKeyDiff[] = [];

  const makeKey = (fk: ForeignKeySchema) => `${fk.columnName}→${fk.referencedTable}.${fk.referencedColumn}`;

  const sourceMap = new Map(sourceFKs.map((fk) => [makeKey(fk), fk]));
  const targetMap = new Map(targetFKs.map((fk) => [makeKey(fk), fk]));

  for (const [key, fk] of targetMap) {
    if (!sourceMap.has(key)) {
      diffs.push({
        action: "added",
        columnName: fk.columnName,
        targetReferencedTable: fk.referencedTable,
        targetReferencedColumn: fk.referencedColumn,
        changes: [`Added FK: ${fk.columnName} → ${fk.referencedTable}(${fk.referencedColumn})`],
      });
    }
  }

  for (const [key, fk] of sourceMap) {
    if (!targetMap.has(key)) {
      diffs.push({
        action: "removed",
        columnName: fk.columnName,
        sourceReferencedTable: fk.referencedTable,
        sourceReferencedColumn: fk.referencedColumn,
        changes: [`Removed FK: ${fk.columnName} → ${fk.referencedTable}(${fk.referencedColumn})`],
      });
    }
  }

  return diffs;
}

/** One object of one reading, with the identity it is compared by and where a migration would find it. */
interface Keyed {
  readonly key: string;
  readonly label: string;
  readonly object: StoredObject;
  /** The path below the compared roots, when the reading carries paths. */
  readonly relative?: readonly string[];
}

/** How many leading container segments every object of a reading shares; `undefined` for an empty reading. */
function sharedContainerDepth(objects: readonly StoredObject[]): number | undefined {
  let shared: readonly string[] | undefined;
  for (const object of objects) {
    const container = (object.path as readonly string[]).slice(0, -1);
    if (shared === undefined) {
      shared = container;
      continue;
    }
    let depth = 0;
    while (depth < shared.length && depth < container.length && shared[depth] === container[depth]) depth++;
    shared = shared.slice(0, depth);
  }
  return shared?.length;
}

/**
 * Each reading's objects by the identity the comparison uses (#789, SF-047).
 *
 * BY PATH below the readings' roots when every object on both sides carries a path. The root of a reading is the
 * container prefix all of its objects share, and both sides drop the SAME number of leading segments, the smaller of
 * the two, so a connection to `STUDIO_DEMO.PROBE` compares against one to `STUDIO_DEMO2.D_DIFF` table by table,
 * while two readings that span schemas keep the schema in the key and `b2a.t1` and `b2b.t1` stay two objects. Keying
 * by name made those two collide and the diff showed whichever `new Map()` kept last.
 *
 * BY NAME when either side has an object with no path. That is a snapshot written before the object model, and keying
 * it by path would report every object as removed and re-added, a diff that invents every change there is. Nothing
 * migrates those records, so they keep the old comparison, collision and all.
 */
function keyedReadings(
  source: readonly StoredObject[],
  target: readonly StoredObject[],
): { source: Keyed[]; target: Keyed[]; root?: readonly string[] } {
  const hasPath = (object: StoredObject) => Array.isArray(object.path) && object.path.length > 0;
  if (![...source, ...target].every(hasPath)) {
    const byName = (object: StoredObject): Keyed => ({ key: object.name, label: object.name, object });
    return { source: source.map(byName), target: target.map(byName) };
  }
  const depths = [sharedContainerDepth(source), sharedContainerDepth(target)].filter(
    (depth): depth is number => depth !== undefined,
  );
  const drop = depths.length === 0 ? 0 : Math.min(...depths);
  const byPath = (object: StoredObject): Keyed => {
    const relative = (object.path as readonly string[]).slice(drop);
    return { key: pathKey(relative), label: objectPathLabel(relative), object, relative };
  };
  const root = source.length > 0 ? (source[0].path as readonly string[]).slice(0, drop) : undefined;
  return { source: source.map(byPath), target: target.map(byPath), root };
}

/** The kind a migration judges an object by: for a pair, whichever side is not a table. */
function judgedKind(...objects: (StoredObject | undefined)[]): string | undefined {
  const kinds = objects.map((object) => object?.kind).filter((kind): kind is string => kind !== undefined);
  return kinds.find((kind) => kind !== "table") ?? kinds[0];
}

/** The identity, label, place and kind a `TableDiff` carries, beside its name. */
function placed(entry: Keyed, path: readonly string[] | undefined, kind: string | undefined) {
  return {
    tableName: entry.object.name,
    key: entry.key,
    label: entry.label,
    ...(path === undefined ? {} : { path }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/**
 * Two readings of a database, compared by the identity `keyedReadings` gives each object (#789, SF-047): the path
 * below the compared roots, or the name for a snapshot taken before the object model.
 *
 * The cost, stated rather than left to be discovered: this cannot say that a table became a view. Both sides carry the
 * kind when both are current readings, and the pair's `kind` is whichever is not a table, so the migration leaves such
 * a pair to a human instead of altering a view as a table.
 */
export function diffSchemas(source: readonly StoredObject[], target: readonly StoredObject[]): SchemaDiff {
  const readings = keyedReadings(source, target);
  const sourceMap = new Map(readings.source.map((entry) => [entry.key, entry]));
  const targetMap = new Map(readings.target.map((entry) => [entry.key, entry]));
  // Where an added object goes: the target's path below the roots, under the source's root. An empty source has no
  // root, so the path stays below the roots, where the session running the migration resolves it; the target's own
  // path would name the target's database and schema.
  const addedPath = (entry: Keyed) =>
    entry.relative === undefined
      ? undefined
      : readings.root === undefined
        ? entry.relative
        : [...readings.root, ...entry.relative];

  const tables: TableDiff[] = [];
  let added = 0,
    removed = 0,
    modified = 0;

  // Added tables
  for (const [key, entry] of targetMap) {
    if (!sourceMap.has(key)) {
      const table = entry.object;
      tables.push({
        action: "added",
        ...placed(entry, addedPath(entry), judgedKind(table)),
        columns: table.columns.map((c) => ({
          action: "added" as const,
          columnName: c.name,
          targetType: c.type,
          targetNullable: c.nullable,
          targetDefault: c.defaultValue,
          targetDefaultSql: c.defaultExpression,
          targetIsPrimary: c.isPrimary,
          changes: [`Added column "${c.name}" (${c.type})`],
        })),
        indexes: (Array.isArray(table.indexes) ? table.indexes : []).map((idx) => ({
          action: "added" as const,
          indexName: idx.name,
          targetColumns: idx.columns,
          targetUnique: idx.unique,
          changes: [`Added index "${idx.name}"`],
        })),
        foreignKeys: (table.foreignKeys || []).map((fk) => ({
          action: "added" as const,
          columnName: fk.columnName,
          targetReferencedTable: fk.referencedTable,
          targetReferencedColumn: fk.referencedColumn,
          changes: [`Added FK: ${fk.columnName} → ${fk.referencedTable}(${fk.referencedColumn})`],
        })),
      });
      added++;
    }
  }

  // Removed tables
  for (const [key, entry] of sourceMap) {
    if (!targetMap.has(key)) {
      const table = entry.object;
      tables.push({
        action: "removed",
        ...placed(entry, entry.relative === undefined ? undefined : entry.object.path, judgedKind(table)),
        columns: table.columns.map((c) => ({
          action: "removed" as const,
          columnName: c.name,
          sourceType: c.type,
          sourceNullable: c.nullable,
          sourceDefault: c.defaultValue,
          sourceIsPrimary: c.isPrimary,
          changes: [`Removed column "${c.name}"`],
        })),
        indexes: [],
        foreignKeys: [],
      });
      removed++;
    }
  }

  // Modified tables
  for (const [key, entry] of sourceMap) {
    const targetEntry = targetMap.get(key);
    if (!targetEntry) continue;
    const sourceTable = entry.object;
    const targetTable = targetEntry.object;

    const columns = diffColumns(sourceTable.columns, targetTable.columns);
    const indexes = diffIndexes(
      Array.isArray(sourceTable.indexes) ? sourceTable.indexes : [],
      Array.isArray(targetTable.indexes) ? targetTable.indexes : [],
    );
    const foreignKeys = diffForeignKeys(sourceTable.foreignKeys || [], targetTable.foreignKeys || []);

    if (columns.length > 0 || indexes.length > 0 || foreignKeys.length > 0) {
      tables.push({
        action: "modified",
        ...placed(
          entry,
          entry.relative === undefined ? undefined : entry.object.path,
          judgedKind(sourceTable, targetTable),
        ),
        columns,
        indexes,
        foreignKeys,
      });
      modified++;
    }
  }

  return {
    tables,
    summary: { added, removed, modified },
    hasChanges: tables.length > 0,
  };
}
