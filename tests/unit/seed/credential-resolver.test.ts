import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveConnectionCredentials,
  resolveAllCredentials,
  resetPlaintextWarnings,
} from '@/lib/seed/credential-resolver';
import type { SeedConnection } from '@/lib/seed/types';

const baseConn: SeedConnection = {
  id: 'test',
  name: 'Test',
  type: 'postgres',
  host: 'localhost',
  roles: ['*'],
};

describe('credential-resolver', () => {
  beforeEach(() => {
    resetPlaintextWarnings();
  });

  afterEach(() => {
    delete process.env.MY_PASSWORD;
    delete process.env.MY_HOST;
    delete process.env.MY_USER;
    delete process.env.MY_DB;
    delete process.env.MY_CONN_STR;
  });

  it('resolves ${VAR} in password field', () => {
    process.env.MY_PASSWORD = 'secret123';
    const conn = { ...baseConn, password: '${MY_PASSWORD}' };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe('secret123');
  });

  it('resolves ${VAR} in connectionString field', () => {
    process.env.MY_CONN_STR = 'mongodb://user:pass@host/db';
    const conn = { ...baseConn, connectionString: '${MY_CONN_STR}' };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.connectionString).toBe('mongodb://user:pass@host/db');
  });

  it('resolves ${VAR} in user, host, database fields', () => {
    process.env.MY_USER = 'admin';
    process.env.MY_HOST = 'db.internal';
    process.env.MY_DB = 'mydb';
    const conn = { ...baseConn, user: '${MY_USER}', host: '${MY_HOST}', database: '${MY_DB}' };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.user).toBe('admin');
    expect(resolved.host).toBe('db.internal');
    expect(resolved.database).toBe('mydb');
  });

  it('throws when env var is not defined', () => {
    const conn = { ...baseConn, password: '${NONEXISTENT_VAR}' };
    expect(() => resolveConnectionCredentials(conn)).toThrow(/NONEXISTENT_VAR/);
  });

  it('leaves fields without ${} pattern unchanged', () => {
    const conn = { ...baseConn, host: 'static-host.internal', port: 5432 };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.host).toBe('static-host.internal');
    expect(resolved.port).toBe(5432);
  });

  it('resolveAllCredentials skips connections with unresolvable vars', () => {
    process.env.MY_PASSWORD = 'good';
    const connections: SeedConnection[] = [
      { ...baseConn, id: 'good', password: '${MY_PASSWORD}' },
      { ...baseConn, id: 'bad', password: '${MISSING}' },
      { ...baseConn, id: 'also-good', host: 'static' },
    ];
    const resolved = resolveAllCredentials(connections);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].id).toBe('good');
    expect(resolved[1].id).toBe('also-good');
  });

  it('does not throw for plaintext passwords, just warns', () => {
    const conn = { ...baseConn, id: 'plain', password: 'hardcoded_secret' };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe('hardcoded_secret');
  });
});
