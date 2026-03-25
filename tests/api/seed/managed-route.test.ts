import { describe, it, expect, beforeEach, mock } from 'bun:test';
import path from 'path';

const FIXTURES = path.resolve(__dirname, '../../fixtures/seed-connections');
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'multi-role-config.yaml');
process.env.ADMIN_PG_PASS = 'admin-secret';
process.env.USER_MYSQL_PASS = 'user-secret';
process.env.SHARED_PG_PASS = 'shared-secret';
process.env.BOTH_PG_PASS = 'both-secret';

// Mock auth — must be before route import
mock.module('@/lib/auth', () => ({
  getSession: mock(() => ({ role: 'admin', username: 'admin@test.com' })),
  verifyJWT: mock(() => ({ role: 'admin', username: 'admin@test.com' })),
}));

import { GET } from '@/app/api/connections/managed/route';
import { resetCache } from '@/lib/seed/config-loader';
import { getSession } from '@/lib/auth';

describe('GET /api/connections/managed', () => {
  beforeEach(() => {
    resetCache();
    // Reset mock to default admin session
    (getSession as ReturnType<typeof mock>).mockImplementation(() =>
      ({ role: 'admin', username: 'admin@test.com' })
    );
  });

  it('returns managed connections for admin role', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections.length).toBeGreaterThan(0);
    expect(data.cacheHint).toBe(60000);
  });

  it('filters connections by role', async () => {
    const res = await GET();
    const data = await res.json();
    const ids = data.connections.map((c: { seedId: string }) => c.seedId);
    expect(ids).toContain('admin-only');
    expect(ids).toContain('everyone');
    expect(ids).toContain('admin-and-user');
  });

  it('strips password from managed:true connections', async () => {
    const res = await GET();
    const data = await res.json();
    const managed = data.connections.find((c: { managed: boolean }) => c.managed);
    if (managed) {
      expect(managed.password).toBeUndefined();
    }
  });

  it('returns 401 when no session', async () => {
    (getSession as ReturnType<typeof mock>).mockImplementation(() => null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns empty array when config file missing', async () => {
    const origPath = process.env.SEED_CONFIG_PATH;
    process.env.SEED_CONFIG_PATH = '/nonexistent/path.yaml';
    resetCache();
    const res = await GET();
    const data = await res.json();
    expect(data.connections).toHaveLength(0);
    process.env.SEED_CONFIG_PATH = origPath;
    resetCache();
  });
});
