import { describe, it, expect } from 'bun:test';
import { filterByRoles, mergeDefaults } from '@/lib/seed/connection-filter';
import type { SeedConnection, SeedDefaults } from '@/lib/seed/types';

const baseConn: SeedConnection = {
  id: 'test',
  name: 'Test',
  type: 'postgres',
  host: 'localhost',
  roles: ['*'],
};

describe('mergeDefaults', () => {
  it('applies defaults when connection fields are missing', () => {
    const defaults: SeedDefaults = { managed: true, environment: 'production' };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.managed).toBe(true);
    expect(merged.environment).toBe('production');
  });

  it('connection-level values override defaults', () => {
    const defaults: SeedDefaults = { managed: true, environment: 'production' };
    const merged = mergeDefaults({ ...baseConn, managed: false, environment: 'staging' }, defaults);
    expect(merged.managed).toBe(false);
    expect(merged.environment).toBe('staging');
  });

  it('returns connection unchanged when no defaults', () => {
    const merged = mergeDefaults({ ...baseConn, managed: true }, undefined);
    expect(merged.managed).toBe(true);
  });

  it('merges ssl defaults', () => {
    const defaults: SeedDefaults = { ssl: { mode: 'require', rejectUnauthorized: true } };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.ssl).toEqual({ mode: 'require', rejectUnauthorized: true });
  });

  it('connection ssl overrides default ssl', () => {
    const defaults: SeedDefaults = { ssl: { mode: 'require' } };
    const merged = mergeDefaults({ ...baseConn, ssl: { mode: 'disable' } }, defaults);
    expect(merged.ssl?.mode).toBe('disable');
  });
});

describe('filterByRoles', () => {
  it('includes connections with wildcard role', () => {
    const result = filterByRoles([{ ...baseConn, roles: ['*'] }], ['user']);
    expect(result).toHaveLength(1);
  });

  it('includes connections matching user role', () => {
    const result = filterByRoles([{ ...baseConn, roles: ['admin'] }], ['admin']);
    expect(result).toHaveLength(1);
  });

  it('excludes connections not matching user role', () => {
    const result = filterByRoles([{ ...baseConn, roles: ['admin'] }], ['user']);
    expect(result).toHaveLength(0);
  });

  it('handles multi-role connections', () => {
    const result = filterByRoles([{ ...baseConn, roles: ['admin', 'user'] }], ['user']);
    expect(result).toHaveLength(1);
  });

  it('maps SeedConnection to ManagedConnection correctly', () => {
    const result = filterByRoles([{
      ...baseConn, id: 'my-pg', managed: true, color: '#FF0000', group: 'Backend',
    }], ['admin']);
    expect(result[0].seedId).toBe('my-pg');
    expect(result[0].id).toBe('seed:my-pg');
    expect(result[0].managed).toBe(true);
    expect(result[0].color).toBe('#FF0000');
    expect(result[0].group).toBe('Backend');
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it('defaults managed to true when not specified', () => {
    const result = filterByRoles([{ ...baseConn }], ['admin']);
    expect(result[0].managed).toBe(true);
  });

  it('returns empty array when no connections match', () => {
    const result = filterByRoles([
      { ...baseConn, roles: ['admin'] },
      { ...baseConn, id: 'other', roles: ['admin'] },
    ], ['user']);
    expect(result).toHaveLength(0);
  });
});
