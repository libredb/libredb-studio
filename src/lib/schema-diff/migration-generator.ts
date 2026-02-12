import type { DatabaseType } from '@/lib/types';
import type { SchemaDiff, TableDiff, ColumnDiff } from './types';

function escapeIdentifier(name: string, dialect: DatabaseType): string {
  switch (dialect) {
    case 'mysql': return `\`${name}\``;
    case 'postgres':
    case 'sqlite':
    default: return `"${name}"`;
  }
}

function generateColumnDef(col: ColumnDiff, dialect: DatabaseType): string {
  const type = col.targetType || col.sourceType || 'TEXT';
  const nullable = col.targetNullable === false ? ' NOT NULL' : '';
  const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : '';
  return `${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal}`;
}

function generateCreateTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  const colDefs = table.columns
    .filter(c => c.action === 'added')
    .map(c => `  ${generateColumnDef(c, dialect)}`);

  // Add primary key constraint
  const pkCols = table.columns.filter(c => c.targetIsPrimary).map(c => escapeIdentifier(c.columnName, dialect));

  lines.push(`CREATE TABLE ${id} (`);
  lines.push(colDefs.join(',\n'));
  if (pkCols.length > 0) {
    lines.push(`,  PRIMARY KEY (${pkCols.join(', ')})`);
  }
  lines.push(');');

  // Indexes
  table.indexes.filter(i => i.action === 'added').forEach(idx => {
    const unique = idx.targetUnique ? 'UNIQUE ' : '';
    const cols = (idx.targetColumns || []).map(c => escapeIdentifier(c, dialect)).join(', ');
    lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
  });

  // Foreign keys
  table.foreignKeys.filter(fk => fk.action === 'added').forEach(fk => {
    lines.push(`ALTER TABLE ${id} ADD CONSTRAINT ${escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect)} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || '', dialect)}(${escapeIdentifier(fk.targetReferencedColumn || '', dialect)});`);
  });

  return lines.join('\n');
}

function generateDropTable(table: TableDiff, dialect: DatabaseType): string {
  return `DROP TABLE IF EXISTS ${escapeIdentifier(table.tableName, dialect)};`;
}

function generateAlterTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  lines.push(`-- Alter table: ${table.tableName}`);

  // Added columns
  table.columns.filter(c => c.action === 'added').forEach(col => {
    lines.push(`ALTER TABLE ${id} ADD COLUMN ${generateColumnDef(col, dialect)};`);
  });

  // Removed columns
  table.columns.filter(c => c.action === 'removed').forEach(col => {
    if (dialect === 'sqlite') {
      lines.push(`-- SQLite: Cannot drop column "${col.columnName}" directly. Requires table recreation.`);
    } else {
      lines.push(`ALTER TABLE ${id} DROP COLUMN ${escapeIdentifier(col.columnName, dialect)};`);
    }
  });

  // Modified columns
  table.columns.filter(c => c.action === 'modified').forEach(col => {
    if (dialect === 'sqlite') {
      lines.push(`-- SQLite: Cannot alter column "${col.columnName}" type directly. Requires table recreation.`);
    } else if (dialect === 'mysql') {
      const type = col.targetType || col.sourceType || 'TEXT';
      const nullable = col.targetNullable === false ? ' NOT NULL' : ' NULL';
      const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : '';
      lines.push(`ALTER TABLE ${id} MODIFY COLUMN ${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal};`);
    } else {
      // PostgreSQL
      if (col.sourceType !== col.targetType) {
        lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} TYPE ${col.targetType};`);
      }
      if (col.sourceNullable !== col.targetNullable) {
        if (col.targetNullable) {
          lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP NOT NULL;`);
        } else {
          lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET NOT NULL;`);
        }
      }
      if (col.sourceDefault !== col.targetDefault) {
        if (col.targetDefault) {
          lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET DEFAULT ${col.targetDefault};`);
        } else {
          lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP DEFAULT;`);
        }
      }
    }
  });

  // Added indexes
  table.indexes.filter(i => i.action === 'added').forEach(idx => {
    const unique = idx.targetUnique ? 'UNIQUE ' : '';
    const cols = (idx.targetColumns || []).map(c => escapeIdentifier(c, dialect)).join(', ');
    lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
  });

  // Removed indexes
  table.indexes.filter(i => i.action === 'removed').forEach(idx => {
    if (dialect === 'mysql') {
      lines.push(`DROP INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id};`);
    } else {
      lines.push(`DROP INDEX IF EXISTS ${escapeIdentifier(idx.indexName, dialect)};`);
    }
  });

  // Added foreign keys
  table.foreignKeys.filter(fk => fk.action === 'added').forEach(fk => {
    const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
    lines.push(`ALTER TABLE ${id} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || '', dialect)}(${escapeIdentifier(fk.targetReferencedColumn || '', dialect)});`);
  });

  // Removed foreign keys
  table.foreignKeys.filter(fk => fk.action === 'removed').forEach(fk => {
    const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
    if (dialect === 'mysql') {
      lines.push(`ALTER TABLE ${id} DROP FOREIGN KEY ${constraintName};`);
    } else if (dialect === 'sqlite') {
      lines.push(`-- SQLite: Cannot drop foreign key directly. Requires table recreation.`);
    } else {
      lines.push(`ALTER TABLE ${id} DROP CONSTRAINT IF EXISTS ${constraintName};`);
    }
  });

  return lines.join('\n');
}

export function generateMigrationSQL(diff: SchemaDiff, dialect: DatabaseType): string {
  if (!diff.hasChanges) {
    return '-- No schema changes detected.';
  }

  const sections: string[] = [];
  sections.push(`-- Migration generated at ${new Date().toISOString()}`);
  sections.push(`-- Dialect: ${dialect}`);
  sections.push(`-- Changes: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.modified} modified`);
  sections.push('');

  if (dialect !== 'sqlite') {
    sections.push('BEGIN;');
    sections.push('');
  }

  // Drop tables first (reverse dependency order)
  const droppedTables = diff.tables.filter(t => t.action === 'removed');
  if (droppedTables.length > 0) {
    sections.push('-- Drop removed tables');
    droppedTables.forEach(t => sections.push(generateDropTable(t, dialect)));
    sections.push('');
  }

  // Create new tables
  const addedTables = diff.tables.filter(t => t.action === 'added');
  if (addedTables.length > 0) {
    sections.push('-- Create new tables');
    addedTables.forEach(t => {
      sections.push(generateCreateTable(t, dialect));
      sections.push('');
    });
  }

  // Alter existing tables
  const modifiedTables = diff.tables.filter(t => t.action === 'modified');
  if (modifiedTables.length > 0) {
    sections.push('-- Modify existing tables');
    modifiedTables.forEach(t => {
      sections.push(generateAlterTable(t, dialect));
      sections.push('');
    });
  }

  if (dialect !== 'sqlite') {
    sections.push('COMMIT;');
  }

  return sections.join('\n');
}
