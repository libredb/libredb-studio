import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import type { DatabaseConnection } from '@/lib/types';

const FIXTURES = path.resolve(__dirname, '../../fixtures/seed-connections');
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'multi-role-config.yaml');
process.env.ADMIN_PG_PASS = 'admin-secret';
process.env.USER_MYSQL_PASS = 'user-secret';
process.env.SHARED_PG_PASS = 'shared-secret';
process.env.BOTH_PG_PASS = 'both-secret';

import { resolveConnection, SeedConnectionError } from '@/lib/seed/resolve-connection';
import { resetCache } from '@/lib/seed/config-loader';

describe('resolve-connection', () => {
  beforeEach(() => {
    resetCache();
  });

  it('returns connection object as-is when no connectionId', async () => {
    const conn: DatabaseConnection = {
      id: 'user-conn', name: 'User DB', type: 'postgres', host: 'localhost', createdAt: new Date(),
    };
    const result = await resolveConnection({ connection: conn }, { role: 'user', username: 'test' });
    expect(result.id).toBe('user-conn');
  });

  it('resolves seed connection by connectionId', async () => {
    const result = await resolveConnection(
      { connectionId: 'seed:everyone' },
      { role: 'user', username: 'test' },
    );
    expect(result.id).toBe('seed:everyone');
    expect(result.password).toBe('shared-secret');
  });

  it('throws 403 when role does not have access', async () => {
    try {
      await resolveConnection({ connectionId: 'seed:admin-only' }, { role: 'user', username: 'test' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
    }
  });

  it('throws 404 when seed connection does not exist', async () => {
    try {
      await resolveConnection({ connectionId: 'seed:nonexistent' }, { role: 'admin', username: 'test' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(404);
    }
  });

  it('admin can access admin-only connections', async () => {
    const result = await resolveConnection(
      { connectionId: 'seed:admin-only' },
      { role: 'admin', username: 'test' },
    );
    expect(result.password).toBe('admin-secret');
  });

  it('throws 400 when neither connection nor connectionId', async () => {
    try {
      await resolveConnection({}, { role: 'admin', username: 'test' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
    }
  });
});
