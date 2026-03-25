import { describe, it, expect } from 'bun:test';
import {
  SeedConnectionSchema,
  SeedConfigSchema,
  SeedDefaultsSchema,
} from '@/lib/seed/types';

describe('SeedConnectionSchema', () => {
  const validConn = {
    id: 'test-pg',
    name: 'Test PG',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    roles: ['admin'],
  };

  it('accepts a valid connection', () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
  });

  it('rejects invalid id format (uppercase)', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, id: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty roles array', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: [] });
    expect(result.success).toBe(false);
  });

  it('accepts wildcard role', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['*'] });
    expect(result.success).toBe(true);
  });

  it('rejects unknown roles like data-team', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['data-team'] });
    expect(result.success).toBe(false);
  });

  it('accepts combined admin and user roles', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['admin', 'user'] });
    expect(result.success).toBe(true);
  });

  it('rejects invalid port range', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, port: 99999 });
    expect(result.success).toBe(false);
  });

  it('accepts valid color hex', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: '#10B981' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid color format', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: 'red' });
    expect(result.success).toBe(false);
  });

  it('accepts all 7 valid database types', () => {
    for (const type of ['postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'oracle', 'mssql']) {
      const result = SeedConnectionSchema.safeParse({ ...validConn, type });
      expect(result.success).toBe(true);
    }
  });
});

describe('SeedConfigSchema', () => {
  it('accepts valid config with version 1', () => {
    const result = SeedConfigSchema.safeParse({
      version: '1',
      connections: [{ id: 'a', name: 'A', type: 'postgres', host: 'h', roles: ['*'] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects version 2', () => {
    const result = SeedConfigSchema.safeParse({
      version: '2',
      connections: [{ id: 'a', name: 'A', type: 'postgres', host: 'h', roles: ['*'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate connection IDs', () => {
    const result = SeedConfigSchema.safeParse({
      version: '1',
      connections: [
        { id: 'dup', name: 'A', type: 'postgres', host: 'h', roles: ['*'] },
        { id: 'dup', name: 'B', type: 'mysql', host: 'h', roles: ['*'] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty connections array', () => {
    const result = SeedConfigSchema.safeParse({ version: '1', connections: [] });
    expect(result.success).toBe(false);
  });
});

describe('SeedDefaultsSchema', () => {
  it('accepts valid ssl config with mode require', () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: 'require', rejectUnauthorized: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects ssl mode prefer (not in SSLMode type)', () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: 'prefer' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid environment', () => {
    const result = SeedDefaultsSchema.safeParse({ environment: 'unknown' });
    expect(result.success).toBe(false);
  });
});
