import type { TableSchema } from '@/lib/types';

export const mockUsersTable: TableSchema = {
  name: 'users',
  columns: [
    { name: 'id', type: 'integer', nullable: false, isPrimary: true, defaultValue: 'nextval(\'users_id_seq\')' },
    { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
    { name: 'email', type: 'varchar(255)', nullable: false, isPrimary: false },
    { name: 'password', type: 'varchar(255)', nullable: false, isPrimary: false },
    { name: 'created_at', type: 'timestamp', nullable: false, isPrimary: false, defaultValue: 'now()' },
    { name: 'is_active', type: 'boolean', nullable: false, isPrimary: false, defaultValue: 'true' },
  ],
  indexes: [
    { name: 'users_pkey', columns: ['id'], unique: true },
    { name: 'users_email_key', columns: ['email'], unique: true },
  ],
  foreignKeys: [],
  rowCount: 100,
  size: '64 kB',
};

export const mockOrdersTable: TableSchema = {
  name: 'orders',
  columns: [
    { name: 'id', type: 'integer', nullable: false, isPrimary: true },
    { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
    { name: 'total', type: 'numeric(10,2)', nullable: false, isPrimary: false },
    { name: 'status', type: 'varchar(50)', nullable: false, isPrimary: false, defaultValue: '\'pending\'' },
    { name: 'created_at', type: 'timestamp', nullable: false, isPrimary: false },
  ],
  indexes: [
    { name: 'orders_pkey', columns: ['id'], unique: true },
    { name: 'orders_user_id_idx', columns: ['user_id'], unique: false },
  ],
  foreignKeys: [
    { columnName: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
  ],
  rowCount: 500,
  size: '128 kB',
};

export const mockProductsTable: TableSchema = {
  name: 'products',
  columns: [
    { name: 'id', type: 'integer', nullable: false, isPrimary: true },
    { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
    { name: 'price', type: 'numeric(10,2)', nullable: false, isPrimary: false },
    { name: 'category', type: 'varchar(100)', nullable: true, isPrimary: false },
  ],
  indexes: [
    { name: 'products_pkey', columns: ['id'], unique: true },
  ],
  foreignKeys: [],
  rowCount: 50,
  size: '32 kB',
};

export const mockSchema: TableSchema[] = [
  mockUsersTable,
  mockOrdersTable,
  mockProductsTable,
];

export const emptySchema: TableSchema[] = [];
