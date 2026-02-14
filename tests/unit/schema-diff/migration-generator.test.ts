import { describe, test, expect } from 'bun:test';
import { generateMigrationSQL } from '@/lib/schema-diff/migration-generator';
import type { SchemaDiff } from '@/lib/schema-diff/types';

// ============================================================================
// Helpers
// ============================================================================

const noChangesDiff: SchemaDiff = {
  tables: [],
  summary: { added: 0, removed: 0, modified: 0 },
  hasChanges: false,
};

function makeAddedTableDiff(): SchemaDiff {
  return {
    tables: [{
      action: 'added',
      tableName: 'users',
      columns: [
        { action: 'added', columnName: 'id', targetType: 'integer', targetNullable: false, targetIsPrimary: true, changes: ['Added column "id"'] },
        { action: 'added', columnName: 'name', targetType: 'varchar(255)', targetNullable: false, targetIsPrimary: false, changes: ['Added column "name"'] },
        { action: 'added', columnName: 'email', targetType: 'varchar(255)', targetNullable: true, targetIsPrimary: false, changes: ['Added column "email"'] },
      ],
      indexes: [
        { action: 'added', indexName: 'idx_users_email', targetColumns: ['email'], targetUnique: true, changes: ['Added index'] },
      ],
      foreignKeys: [],
    }],
    summary: { added: 1, removed: 0, modified: 0 },
    hasChanges: true,
  };
}

function makeDroppedTableDiff(): SchemaDiff {
  return {
    tables: [{
      action: 'removed',
      tableName: 'legacy',
      columns: [
        { action: 'removed', columnName: 'id', sourceType: 'integer', changes: ['Removed column'] },
      ],
      indexes: [],
      foreignKeys: [],
    }],
    summary: { added: 0, removed: 1, modified: 0 },
    hasChanges: true,
  };
}

function makeModifiedTableDiff(): SchemaDiff {
  return {
    tables: [{
      action: 'modified',
      tableName: 'users',
      columns: [
        { action: 'added', columnName: 'phone', targetType: 'varchar(20)', targetNullable: true, changes: ['Added column "phone"'] },
        { action: 'removed', columnName: 'legacy_col', sourceType: 'text', changes: ['Removed column'] },
        {
          action: 'modified', columnName: 'name',
          sourceType: 'varchar(100)', targetType: 'varchar(255)',
          sourceNullable: true, targetNullable: false,
          sourceDefault: undefined, targetDefault: "'unknown'",
          changes: ['Type changed', 'Nullable changed', 'Default changed'],
        },
      ],
      indexes: [
        { action: 'added', indexName: 'idx_phone', targetColumns: ['phone'], targetUnique: false, changes: ['Added index'] },
        { action: 'removed', indexName: 'idx_legacy', sourceColumns: ['legacy_col'], changes: ['Removed index'] },
      ],
      foreignKeys: [
        { action: 'added', columnName: 'dept_id', targetReferencedTable: 'departments', targetReferencedColumn: 'id', changes: ['Added FK'] },
        { action: 'removed', columnName: 'old_ref', sourceReferencedTable: 'old_table', sourceReferencedColumn: 'id', changes: ['Removed FK'] },
      ],
    }],
    summary: { added: 0, removed: 0, modified: 1 },
    hasChanges: true,
  };
}

// ============================================================================
// No changes
// ============================================================================

describe('generateMigrationSQL: no changes', () => {
  test('returns comment when no changes', () => {
    const sql = generateMigrationSQL(noChangesDiff, 'postgres');
    expect(sql).toBe('-- No schema changes detected.');
  });
});

// ============================================================================
// CREATE TABLE
// ============================================================================

describe('generateMigrationSQL: CREATE TABLE', () => {
  test('postgres uses double-quoted identifiers', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'postgres');
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"id" integer NOT NULL');
    expect(sql).toContain('"name" varchar(255) NOT NULL');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  test('mysql uses backtick identifiers', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'mysql');
    expect(sql).toContain('CREATE TABLE `users`');
    expect(sql).toContain('`id` integer NOT NULL');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  test('sqlite uses double-quoted identifiers and no BEGIN/COMMIT', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'sqlite');
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).not.toContain('BEGIN;');
    expect(sql).not.toContain('COMMIT;');
  });

  test('mssql uses bracket identifiers', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'mssql');
    expect(sql).toContain('CREATE TABLE [users]');
    expect(sql).toContain('[id] integer NOT NULL');
    expect(sql).toContain('BEGIN;');
  });

  test('oracle uses double-quoted identifiers', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'oracle');
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('BEGIN;');
  });
});

// ============================================================================
// DROP TABLE
// ============================================================================

describe('generateMigrationSQL: DROP TABLE', () => {
  test('generates DROP TABLE IF EXISTS', () => {
    const sql = generateMigrationSQL(makeDroppedTableDiff(), 'postgres');
    expect(sql).toContain('DROP TABLE IF EXISTS "legacy"');
  });

  test('mysql uses backtick for DROP', () => {
    const sql = generateMigrationSQL(makeDroppedTableDiff(), 'mysql');
    expect(sql).toContain('DROP TABLE IF EXISTS `legacy`');
  });
});

// ============================================================================
// ALTER TABLE
// ============================================================================

describe('generateMigrationSQL: ALTER TABLE', () => {
  test('postgres: ADD COLUMN, DROP COLUMN, ALTER COLUMN TYPE/NULL/DEFAULT', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'postgres');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "phone" varchar(20)');
    expect(sql).toContain('ALTER TABLE "users" DROP COLUMN "legacy_col"');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(255)');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL');
    expect(sql).toContain("ALTER TABLE \"users\" ALTER COLUMN \"name\" SET DEFAULT 'unknown'");
  });

  test('mysql: MODIFY COLUMN syntax', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'mysql');
    expect(sql).toContain('ALTER TABLE `users` MODIFY COLUMN `name` varchar(255) NOT NULL');
  });

  test('sqlite: column drop produces comment', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'sqlite');
    expect(sql).toContain('-- SQLite: Cannot drop column "legacy_col" directly');
    expect(sql).toContain('-- SQLite: Cannot alter column "name" type directly');
  });

  test('mssql: ALTER COLUMN syntax', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'mssql');
    expect(sql).toContain('ALTER TABLE [users] ALTER COLUMN [name] varchar(255) NOT NULL');
    expect(sql).toContain("ALTER TABLE [users] ADD DEFAULT 'unknown' FOR [name]");
  });

  test('oracle: MODIFY() syntax', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'oracle');
    expect(sql).toContain('ALTER TABLE "users" MODIFY ("name"');
  });
});

// ============================================================================
// Index operations in ALTER TABLE
// ============================================================================

describe('generateMigrationSQL: indexes in ALTER', () => {
  test('CREATE INDEX for added index', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'postgres');
    expect(sql).toContain('CREATE INDEX "idx_phone" ON "users" ("phone")');
  });

  test('CREATE UNIQUE INDEX for added unique index', () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), 'postgres');
    expect(sql).toContain('CREATE UNIQUE INDEX');
  });

  test('DROP INDEX for removed index (postgres)', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'postgres');
    expect(sql).toContain('DROP INDEX IF EXISTS "idx_legacy"');
  });

  test('DROP INDEX ON for removed index (mysql)', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'mysql');
    expect(sql).toContain('DROP INDEX `idx_legacy` ON `users`');
  });
});

// ============================================================================
// Foreign key operations in ALTER TABLE
// ============================================================================

describe('generateMigrationSQL: foreign keys in ALTER', () => {
  test('ADD CONSTRAINT for added FK', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'postgres');
    expect(sql).toContain('ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY ("dept_id") REFERENCES "departments"("id")');
  });

  test('DROP CONSTRAINT for removed FK (postgres)', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'postgres');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "fk_users_old_ref"');
  });

  test('DROP FOREIGN KEY for removed FK (mysql)', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'mysql');
    expect(sql).toContain('DROP FOREIGN KEY `fk_users_old_ref`');
  });

  test('SQLite FK drop produces comment', () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), 'sqlite');
    expect(sql).toContain('-- SQLite: Cannot drop foreign key directly');
  });
});
