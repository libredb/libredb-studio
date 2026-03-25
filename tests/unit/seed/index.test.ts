import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import {
  getManagedConnections,
  getSeedConnectionById,
  getSeedConnectionByIdUnfiltered,
  resetCache,
} from '@/lib/seed';
import { resetPlaintextWarnings } from '@/lib/seed/credential-resolver';

const FIXTURES = path.resolve(__dirname, '../../fixtures/seed-connections');

describe('seed/index orchestrator', () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'multi-role-config.yaml');
    process.env.ADMIN_PG_PASS = 'admin-secret';
    process.env.USER_MYSQL_PASS = 'user-secret';
    process.env.SHARED_PG_PASS = 'shared-secret';
    process.env.BOTH_PG_PASS = 'both-secret';
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.ADMIN_PG_PASS;
    delete process.env.USER_MYSQL_PASS;
    delete process.env.SHARED_PG_PASS;
    delete process.env.BOTH_PG_PASS;
  });

  it('getManagedConnections returns role-filtered connections', async () => {
    const adminConns = await getManagedConnections(['admin']);
    expect(adminConns.length).toBeGreaterThanOrEqual(3);

    const userConns = await getManagedConnections(['user']);
    const userIds = userConns.map((c) => c.seedId);
    expect(userIds).toContain('everyone');
    expect(userIds).toContain('user-only');
    expect(userIds).not.toContain('admin-only');
  });

  it('getSeedConnectionById returns connection with role check', async () => {
    const conn = await getSeedConnectionById('everyone', ['user']);
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe('everyone');
    expect(conn!.password).toBe('shared-secret');
  });

  it('getSeedConnectionById returns null when role mismatches', async () => {
    const conn = await getSeedConnectionById('admin-only', ['user']);
    expect(conn).toBeNull();
  });

  it('getSeedConnectionByIdUnfiltered returns connection regardless of role', async () => {
    const conn = await getSeedConnectionByIdUnfiltered('admin-only');
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe('admin-only');
  });

  it('getSeedConnectionByIdUnfiltered returns null for nonexistent ID', async () => {
    const conn = await getSeedConnectionByIdUnfiltered('nonexistent');
    expect(conn).toBeNull();
  });

  it('returns empty array when config file missing', async () => {
    process.env.SEED_CONFIG_PATH = '/nonexistent.yaml';
    resetCache();
    const conns = await getManagedConnections(['admin']);
    expect(conns).toHaveLength(0);
  });
});
