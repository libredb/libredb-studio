import type { ColumnSequence } from "@/lib/types";

export type DiffAction = "added" | "removed" | "modified";

export interface ColumnDiff {
  action: DiffAction;
  columnName: string;
  sourceType?: string;
  targetType?: string;
  /**
   * The type as the column was declared, modifier included (`character varying(50)`,
   * `numeric(12,2)`), carried from `ColumnSchema.declaredType` where the provider reads one.
   * `targetType` is the base name, so DDL written from it alone dropped every length and
   * precision (D05). The migration writes this one where it is present.
   */
  sourceDeclaredType?: string;
  targetDeclaredType?: string;
  /**
   * Whether the engine numbers the added column itself, from `ColumnSchema.autoIncrement` where the provider read
   * it: an identity column, `AUTO_INCREMENT`, or one a sequence feeds. Each engine's column definition writes its
   * own clause for it (R8); absent, the column is written as a plain one, as it always was.
   */
  targetAutoIncrement?: boolean;
  /**
   * Whether the added column is computed, from `ColumnSchema.generated`: its `targetDefault` is then the generation
   * expression, which an engine's column definition writes as one rather than as a DEFAULT (R9).
   */
  targetGenerated?: "stored" | "virtual";
  /**
   * The options and owner of the sequence the added column's default draws from, from `ColumnSchema.sequence`: the
   * migration creates the sequence with them and gives it back to its column.
   */
  targetSequence?: ColumnSequence;
  sourceNullable?: boolean;
  targetNullable?: boolean;
  sourceDefault?: string;
  targetDefault?: string;
  /**
   * The SQL text that produces `targetDefault`, carried from `ColumnSchema.defaultExpression`
   * and preferred by every site that emits a DEFAULT clause. Absent where the provider could
   * not say, and then the generator falls back to `targetDefault`.
   *
   * The target only: `sourceDefault` is compared and read for a ClickHouse REMOVE keyword,
   * and is never interpolated into emitted SQL.
   */
  targetDefaultSql?: string;
  sourceIsPrimary?: boolean;
  targetIsPrimary?: boolean;
  changes: string[];
}

export interface IndexDiff {
  action: DiffAction;
  indexName: string;
  sourceColumns?: string[];
  targetColumns?: string[];
  sourceUnique?: boolean;
  targetUnique?: boolean;
  changes: string[];
}

export interface ForeignKeyDiff {
  action: DiffAction;
  columnName: string;
  sourceReferencedTable?: string;
  targetReferencedTable?: string;
  /**
   * The referenced table's path where the migration acts on it, segment by segment, when the
   * target reading holds the table the foreign key names: placed the way an added table is, under
   * the source's root. `targetReferencedTable` is one string each provider spells in its own
   * dialect (`app.customers`), and quoting it whole made `"app.customers"`, one identifier that
   * names no table (D05). Absent when the reading has no paths or does not hold the table, and the
   * migration then writes the spelling as it always did.
   */
  targetReferencedPath?: readonly string[];
  sourceReferencedColumn?: string;
  targetReferencedColumn?: string;
  changes: string[];
}

export interface TableDiff {
  action: DiffAction;
  /** The object's name as the reading spelled it; the migration's generated constraint names are built from it. */
  tableName: string;
  /**
   * The object's identity in this diff, unique within it: its path below the compared roots when both readings carry
   * paths, else its name (SF-047). Absent on a diff built by hand, where `tableName` is the identity.
   */
  key?: string;
  /** What the panel shows for the object: the dotted path below the compared roots, or the name. */
  label?: string;
  /**
   * The object's full path where the migration acts on it: the source's object for a removed or modified one, and
   * for an added one the target's path below the roots, placed under the source's root. Absent when either reading
   * has no paths (a snapshot taken before the object model), and then the migration names the object by `tableName`.
   */
  path?: readonly string[];
  /**
   * The kind the reading declared for the object, when it declared one: the source's for a removed object, the
   * target's for an added one, and for a modified one whichever side is not `table`. The migration alters, creates and
   * drops only tables, so a view is named in a comment instead.
   */
  kind?: string;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  foreignKeys: ForeignKeyDiff[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  modified: number;
}

export interface SchemaDiff {
  tables: TableDiff[];
  summary: DiffSummary;
  hasChanges: boolean;
}
