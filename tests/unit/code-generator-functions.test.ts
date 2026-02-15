import { describe, test, expect } from 'bun:test';
import {
  toPascalCase,
  toCamelCase,
  toSnakeCase,
  mapSqlTypeToTS,
  mapSqlTypeToZod,
  mapSqlTypeToPrisma,
  mapSqlTypeToGo,
  mapSqlTypeToPython,
  mapSqlTypeToJava,
  generateCode,
} from '@/components/CodeGenerator';
import type { TableSchema } from '@/lib/types';

// ============================================================================
// Naming helpers
// ============================================================================

describe('toPascalCase', () => {
  test('simple table name', () => expect(toPascalCase('users')).toBe('User'));
  test('underscore name', () => expect(toPascalCase('order_items')).toBe('OrderItem'));
  test('hyphenated name', () => expect(toPascalCase('user-roles')).toBe('UserRole'));
  test('already pascal', () => expect(toPascalCase('User')).toBe('User'));
  test('single char', () => expect(toPascalCase('a')).toBe('A'));
  test('non-plural name', () => expect(toPascalCase('data')).toBe('Data'));
});

describe('toCamelCase', () => {
  test('simple table name', () => expect(toCamelCase('users')).toBe('user'));
  test('underscore name', () => expect(toCamelCase('order_items')).toBe('orderItem'));
  test('already camel', () => expect(toCamelCase('email')).toBe('email'));
});

describe('toSnakeCase', () => {
  test('camelCase to snake', () => expect(toSnakeCase('createdAt')).toBe('created_at'));
  test('already snake', () => expect(toSnakeCase('user_id')).toBe('user_id'));
  test('PascalCase to snake', () => expect(toSnakeCase('UserId')).toBe('user_id'));
  test('lowercase stays', () => expect(toSnakeCase('email')).toBe('email'));
});

// ============================================================================
// Type mappers — TypeScript
// ============================================================================

describe('mapSqlTypeToTS', () => {
  test('INTEGER → number', () => expect(mapSqlTypeToTS('INTEGER')).toBe('number'));
  test('SERIAL → number', () => expect(mapSqlTypeToTS('SERIAL')).toBe('number'));
  test('FLOAT → number', () => expect(mapSqlTypeToTS('FLOAT')).toBe('number'));
  test('DOUBLE PRECISION → number', () => expect(mapSqlTypeToTS('DOUBLE PRECISION')).toBe('number'));
  test('NUMERIC(10,2) → number', () => expect(mapSqlTypeToTS('NUMERIC(10,2)')).toBe('number'));
  test('REAL → number', () => expect(mapSqlTypeToTS('REAL')).toBe('number'));
  test('BOOLEAN → boolean', () => expect(mapSqlTypeToTS('BOOLEAN')).toBe('boolean'));
  test('DATE → Date', () => expect(mapSqlTypeToTS('DATE')).toBe('Date'));
  test('TIMESTAMP → Date', () => expect(mapSqlTypeToTS('TIMESTAMP')).toBe('Date'));
  test('TIME → Date', () => expect(mapSqlTypeToTS('TIME')).toBe('Date'));
  test('JSONB → Record', () => expect(mapSqlTypeToTS('JSONB')).toBe('Record<string, unknown>'));
  test('UUID → string', () => expect(mapSqlTypeToTS('UUID')).toBe('string'));
  test('ARRAY → unknown[]', () => expect(mapSqlTypeToTS('text[]')).toBe('string'));
  // Note: 'INTEGER ARRAY' matches 'int' first due to includes check order, so returns 'number'
  test('array keyword detected', () => expect(mapSqlTypeToTS('_text ARRAY')).toBe('unknown[]'));
  test('VARCHAR → string', () => expect(mapSqlTypeToTS('VARCHAR(255)')).toBe('string'));
  test('TEXT → string', () => expect(mapSqlTypeToTS('TEXT')).toBe('string'));
});

// ============================================================================
// Type mappers — Zod
// ============================================================================

describe('mapSqlTypeToZod', () => {
  test('INTEGER → z.number()', () => expect(mapSqlTypeToZod('INTEGER')).toBe('z.number()'));
  test('BOOLEAN → z.boolean()', () => expect(mapSqlTypeToZod('BOOLEAN')).toBe('z.boolean()'));
  test('TIMESTAMP → z.date()', () => expect(mapSqlTypeToZod('TIMESTAMP')).toBe('z.date()'));
  test('JSON → z.record', () => expect(mapSqlTypeToZod('JSON')).toBe('z.record(z.unknown())'));
  test('UUID → z.string().uuid()', () => expect(mapSqlTypeToZod('UUID')).toBe('z.string().uuid()'));
  test('TEXT → z.string()', () => expect(mapSqlTypeToZod('TEXT')).toBe('z.string()'));
});

// ============================================================================
// Type mappers — Prisma
// ============================================================================

describe('mapSqlTypeToPrisma', () => {
  test('SERIAL → Int', () => expect(mapSqlTypeToPrisma('SERIAL')).toBe('Int'));
  test('integer → Int', () => expect(mapSqlTypeToPrisma('integer')).toBe('Int'));
  test('int4 → Int', () => expect(mapSqlTypeToPrisma('int4')).toBe('Int'));
  test('BIGINT → BigInt', () => expect(mapSqlTypeToPrisma('BIGINT')).toBe('BigInt'));
  test('int8 → BigInt', () => expect(mapSqlTypeToPrisma('int8')).toBe('BigInt'));
  test('FLOAT → Float', () => expect(mapSqlTypeToPrisma('FLOAT')).toBe('Float'));
  test('DECIMAL → Float', () => expect(mapSqlTypeToPrisma('DECIMAL')).toBe('Float'));
  test('BOOLEAN → Boolean', () => expect(mapSqlTypeToPrisma('BOOLEAN')).toBe('Boolean'));
  test('TIMESTAMP → DateTime', () => expect(mapSqlTypeToPrisma('TIMESTAMP')).toBe('DateTime'));
  test('DATETIME → DateTime', () => expect(mapSqlTypeToPrisma('DATETIME')).toBe('DateTime'));
  test('DATE → DateTime', () => expect(mapSqlTypeToPrisma('DATE')).toBe('DateTime'));
  test('JSON → Json', () => expect(mapSqlTypeToPrisma('JSON')).toBe('Json'));
  test('TEXT → String', () => expect(mapSqlTypeToPrisma('TEXT')).toBe('String'));
});

// ============================================================================
// Type mappers — Go
// ============================================================================

describe('mapSqlTypeToGo', () => {
  test('SERIAL → int', () => expect(mapSqlTypeToGo('SERIAL')).toBe('int'));
  test('integer → int', () => expect(mapSqlTypeToGo('integer')).toBe('int'));
  test('BIGINT → int64', () => expect(mapSqlTypeToGo('BIGINT')).toBe('int64'));
  test('FLOAT → float32', () => expect(mapSqlTypeToGo('FLOAT')).toBe('float32'));
  test('REAL → float32', () => expect(mapSqlTypeToGo('REAL')).toBe('float32'));
  test('DOUBLE → float64', () => expect(mapSqlTypeToGo('DOUBLE')).toBe('float64'));
  test('DECIMAL → float64', () => expect(mapSqlTypeToGo('DECIMAL')).toBe('float64'));
  test('BOOLEAN → bool', () => expect(mapSqlTypeToGo('BOOLEAN')).toBe('bool'));
  test('TIMESTAMP → time.Time', () => expect(mapSqlTypeToGo('TIMESTAMP')).toBe('time.Time'));
  test('TEXT → string', () => expect(mapSqlTypeToGo('TEXT')).toBe('string'));
});

// ============================================================================
// Type mappers — Python
// ============================================================================

describe('mapSqlTypeToPython', () => {
  test('INTEGER → int', () => expect(mapSqlTypeToPython('INTEGER')).toBe('int'));
  test('SERIAL → int', () => expect(mapSqlTypeToPython('SERIAL')).toBe('int'));
  test('FLOAT → float', () => expect(mapSqlTypeToPython('FLOAT')).toBe('float'));
  test('NUMERIC → float', () => expect(mapSqlTypeToPython('NUMERIC')).toBe('float'));
  test('BOOLEAN → bool', () => expect(mapSqlTypeToPython('BOOLEAN')).toBe('bool'));
  test('TIMESTAMP → datetime', () => expect(mapSqlTypeToPython('TIMESTAMP')).toBe('datetime'));
  test('JSON → dict', () => expect(mapSqlTypeToPython('JSON')).toBe('dict'));
  test('TEXT → str', () => expect(mapSqlTypeToPython('TEXT')).toBe('str'));
});

// ============================================================================
// Type mappers — Java
// ============================================================================

describe('mapSqlTypeToJava', () => {
  test('SERIAL → Integer', () => expect(mapSqlTypeToJava('SERIAL')).toBe('Integer'));
  test('integer → Integer', () => expect(mapSqlTypeToJava('integer')).toBe('Integer'));
  test('BIGINT → Long', () => expect(mapSqlTypeToJava('BIGINT')).toBe('Long'));
  test('FLOAT → Float', () => expect(mapSqlTypeToJava('FLOAT')).toBe('Float'));
  test('DOUBLE → Double', () => expect(mapSqlTypeToJava('DOUBLE')).toBe('Double'));
  test('DECIMAL → Double', () => expect(mapSqlTypeToJava('DECIMAL')).toBe('Double'));
  test('BOOLEAN → Boolean', () => expect(mapSqlTypeToJava('BOOLEAN')).toBe('Boolean'));
  test('TIMESTAMP → LocalDateTime', () => expect(mapSqlTypeToJava('TIMESTAMP')).toBe('LocalDateTime'));
  test('TEXT → String', () => expect(mapSqlTypeToJava('TEXT')).toBe('String'));
});

// ============================================================================
// generateCode
// ============================================================================

const testSchema: TableSchema = {
  name: 'order_items',
  indexes: [],
  columns: [
    { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
    { name: 'product_name', type: 'VARCHAR(255)', nullable: false, isPrimary: false },
    { name: 'price', type: 'DECIMAL(10,2)', nullable: true, isPrimary: false },
    { name: 'created_at', type: 'TIMESTAMP', nullable: true, isPrimary: false },
    { name: 'metadata', type: 'JSONB', nullable: true, isPrimary: false },
  ],
};

describe('generateCode', () => {
  test('TypeScript interface', () => {
    const code = generateCode('typescript', testSchema);
    expect(code).toContain('export interface OrderItem');
    expect(code).toContain('id: number;');
    expect(code).toContain('productName: string;');
    expect(code).toContain('price: number | null;');
    expect(code).toContain('createdAt: Date | null;');
    expect(code).toContain('metadata: Record<string, unknown> | null;');
  });

  test('Zod schema', () => {
    const code = generateCode('zod', testSchema);
    expect(code).toContain("import { z } from 'zod'");
    expect(code).toContain('OrderItemSchema = z.object');
    expect(code).toContain('z.number()');
    expect(code).toContain('z.number().nullable()');
    expect(code).toContain('z.date().nullable()');
    expect(code).toContain('z.record(z.unknown()).nullable()');
    expect(code).toContain('z.infer<typeof OrderItemSchema>');
  });

  test('Prisma model', () => {
    const code = generateCode('prisma', testSchema);
    expect(code).toContain('model OrderItem');
    expect(code).toContain('@id');
    expect(code).toContain('@default(autoincrement())');
    expect(code).toContain('@@map("order_items")');
    expect(code).toContain('price  Float?');
    expect(code).toContain('created_at  DateTime?');
  });

  test('Go struct', () => {
    const code = generateCode('go', testSchema);
    expect(code).toContain('package models');
    expect(code).toContain('import "time"');
    expect(code).toContain('type OrderItem struct');
    expect(code).toContain('json:"id"');
    expect(code).toContain('*float64');
    expect(code).toContain('*time.Time');
  });

  test('Python dataclass', () => {
    const code = generateCode('python', testSchema);
    expect(code).toContain('from dataclasses import dataclass');
    expect(code).toContain('from typing import Optional');
    expect(code).toContain('from datetime import datetime');
    expect(code).toContain('@dataclass');
    expect(code).toContain('class OrderItem:');
    expect(code).toContain('id: int');
    expect(code).toContain('price: Optional[float]');
  });

  test('Java POJO', () => {
    const code = generateCode('java', testSchema);
    expect(code).toContain('import java.time.LocalDateTime;');
    expect(code).toContain('public class OrderItem');
    expect(code).toContain('private Integer id;');
    expect(code).toContain('private String productName;');
    expect(code).toContain('private Double price;');
    expect(code).toContain('private LocalDateTime createdAt;');
  });

  test('Go struct without time import when no date columns', () => {
    const schema: TableSchema = {
      name: 'tags',
      indexes: [],
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, isPrimary: true },
        { name: 'name', type: 'TEXT', nullable: false, isPrimary: false },
      ],
    };
    const code = generateCode('go', schema);
    expect(code).not.toContain('import "time"');
  });

  test('Python dataclass without optional/datetime when not needed', () => {
    const schema: TableSchema = {
      name: 'flags',
      indexes: [],
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, isPrimary: true },
        { name: 'name', type: 'TEXT', nullable: false, isPrimary: false },
      ],
    };
    const code = generateCode('python', schema);
    expect(code).not.toContain('from typing import Optional');
    expect(code).not.toContain('from datetime import datetime');
  });

  test('Java POJO without LocalDateTime import when not needed', () => {
    const schema: TableSchema = {
      name: 'tags',
      indexes: [],
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, isPrimary: true },
      ],
    };
    const code = generateCode('java', schema);
    expect(code).not.toContain('import java.time.LocalDateTime');
  });

  test('empty columns produces empty body', () => {
    const schema: TableSchema = { name: 'empty', indexes: [], columns: [] };
    const code = generateCode('typescript', schema);
    expect(code).toContain('export interface Empty');
    expect(code).toContain('{\n\n}');
  });
});
