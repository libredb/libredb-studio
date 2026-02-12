import type { TableSchema, ColumnSchema, IndexSchema, ForeignKeySchema } from '@/lib/types';
import type { SchemaDiff, TableDiff, ColumnDiff, IndexDiff, ForeignKeyDiff } from './types';

function diffColumns(sourceCols: ColumnSchema[], targetCols: ColumnSchema[]): ColumnDiff[] {
  const diffs: ColumnDiff[] = [];
  const sourceMap = new Map(sourceCols.map(c => [c.name, c]));
  const targetMap = new Map(targetCols.map(c => [c.name, c]));

  // Added columns (in target but not in source)
  for (const [name, col] of targetMap) {
    if (!sourceMap.has(name)) {
      diffs.push({
        action: 'added',
        columnName: name,
        targetType: col.type,
        targetNullable: col.nullable,
        targetDefault: col.defaultValue,
        targetIsPrimary: col.isPrimary,
        changes: [`Added column "${name}" (${col.type})`],
      });
    }
  }

  // Removed columns (in source but not in target)
  for (const [name, col] of sourceMap) {
    if (!targetMap.has(name)) {
      diffs.push({
        action: 'removed',
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
    if ((sourceCol.defaultValue || '') !== (targetCol.defaultValue || '')) {
      changes.push(`Default changed: ${sourceCol.defaultValue || 'none'} → ${targetCol.defaultValue || 'none'}`);
    }
    if (sourceCol.isPrimary !== targetCol.isPrimary) {
      changes.push(`Primary key changed: ${sourceCol.isPrimary} → ${targetCol.isPrimary}`);
    }

    if (changes.length > 0) {
      diffs.push({
        action: 'modified',
        columnName: name,
        sourceType: sourceCol.type,
        targetType: targetCol.type,
        sourceNullable: sourceCol.nullable,
        targetNullable: targetCol.nullable,
        sourceDefault: sourceCol.defaultValue,
        targetDefault: targetCol.defaultValue,
        sourceIsPrimary: sourceCol.isPrimary,
        targetIsPrimary: targetCol.isPrimary,
        changes,
      });
    }
  }

  return diffs;
}

function diffIndexes(sourceIndexes: IndexSchema[], targetIndexes: IndexSchema[]): IndexDiff[] {
  const diffs: IndexDiff[] = [];

  const sourceMap = new Map<string, IndexSchema>();
  sourceIndexes.forEach(idx => {
    const key = idx.name || idx.columns.sort().join(',');
    sourceMap.set(key, idx);
  });

  const targetMap = new Map<string, IndexSchema>();
  targetIndexes.forEach(idx => {
    const key = idx.name || idx.columns.sort().join(',');
    targetMap.set(key, idx);
  });

  for (const [key, idx] of targetMap) {
    if (!sourceMap.has(key)) {
      diffs.push({
        action: 'added',
        indexName: idx.name || key,
        targetColumns: idx.columns,
        targetUnique: idx.unique,
        changes: [`Added index "${idx.name || key}" on (${idx.columns.join(', ')})`],
      });
    }
  }

  for (const [key, idx] of sourceMap) {
    if (!targetMap.has(key)) {
      diffs.push({
        action: 'removed',
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
    const sourceColStr = sourceIdx.columns.sort().join(',');
    const targetColStr = targetIdx.columns.sort().join(',');

    if (sourceColStr !== targetColStr) {
      changes.push(`Columns changed: (${sourceIdx.columns.join(', ')}) → (${targetIdx.columns.join(', ')})`);
    }
    if (sourceIdx.unique !== targetIdx.unique) {
      changes.push(`Unique changed: ${sourceIdx.unique} → ${targetIdx.unique}`);
    }

    if (changes.length > 0) {
      diffs.push({
        action: 'modified',
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

function diffForeignKeys(sourceFKs: ForeignKeySchema[], targetFKs: ForeignKeySchema[]): ForeignKeyDiff[] {
  const diffs: ForeignKeyDiff[] = [];

  const makeKey = (fk: ForeignKeySchema) => `${fk.columnName}→${fk.referencedTable}.${fk.referencedColumn}`;

  const sourceMap = new Map(sourceFKs.map(fk => [makeKey(fk), fk]));
  const targetMap = new Map(targetFKs.map(fk => [makeKey(fk), fk]));

  for (const [key, fk] of targetMap) {
    if (!sourceMap.has(key)) {
      diffs.push({
        action: 'added',
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
        action: 'removed',
        columnName: fk.columnName,
        sourceReferencedTable: fk.referencedTable,
        sourceReferencedColumn: fk.referencedColumn,
        changes: [`Removed FK: ${fk.columnName} → ${fk.referencedTable}(${fk.referencedColumn})`],
      });
    }
  }

  return diffs;
}

export function diffSchemas(source: TableSchema[], target: TableSchema[]): SchemaDiff {
  const sourceMap = new Map(source.map(t => [t.name, t]));
  const targetMap = new Map(target.map(t => [t.name, t]));

  const tables: TableDiff[] = [];
  let added = 0, removed = 0, modified = 0;

  // Added tables
  for (const [name, table] of targetMap) {
    if (!sourceMap.has(name)) {
      tables.push({
        action: 'added',
        tableName: name,
        columns: table.columns.map(c => ({
          action: 'added' as const,
          columnName: c.name,
          targetType: c.type,
          targetNullable: c.nullable,
          targetDefault: c.defaultValue,
          targetIsPrimary: c.isPrimary,
          changes: [`Added column "${c.name}" (${c.type})`],
        })),
        indexes: table.indexes.map(idx => ({
          action: 'added' as const,
          indexName: idx.name,
          targetColumns: idx.columns,
          targetUnique: idx.unique,
          changes: [`Added index "${idx.name}"`],
        })),
        foreignKeys: (table.foreignKeys || []).map(fk => ({
          action: 'added' as const,
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
  for (const [name, table] of sourceMap) {
    if (!targetMap.has(name)) {
      tables.push({
        action: 'removed',
        tableName: name,
        columns: table.columns.map(c => ({
          action: 'removed' as const,
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
  for (const [name, sourceTable] of sourceMap) {
    const targetTable = targetMap.get(name);
    if (!targetTable) continue;

    const columns = diffColumns(sourceTable.columns, targetTable.columns);
    const indexes = diffIndexes(sourceTable.indexes, targetTable.indexes);
    const foreignKeys = diffForeignKeys(sourceTable.foreignKeys || [], targetTable.foreignKeys || []);

    if (columns.length > 0 || indexes.length > 0 || foreignKeys.length > 0) {
      tables.push({
        action: 'modified',
        tableName: name,
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
