import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── Controllable mock for getStorageConfig ────────────────────────────────────
// Default: behaves normally (reads from env); override per-test to throw.

let mockGetStorageConfig: (() => { provider: string; serverMode: boolean }) | null = null;

mock.module('@/lib/storage/factory', () => ({
  getStorageConfig: () => {
    if (mockGetStorageConfig) return mockGetStorageConfig();
    // Real implementation: read env var
    const env = process.env.STORAGE_PROVIDER?.toLowerCase();
    const provider = env === 'sqlite' || env === 'postgres' ? env : 'local';
    return { provider, serverMode: provider !== 'local' };
  },
}));

import { GET } from '@/app/api/storage/config/route';

describe('GET /api/storage/config', () => {
  const originalEnv = process.env.STORAGE_PROVIDER;

  beforeEach(() => {
    delete process.env.STORAGE_PROVIDER;
    mockGetStorageConfig = null;
  });

  afterEach(() => {
    mockGetStorageConfig = null;
    if (originalEnv === undefined) {
      delete process.env.STORAGE_PROVIDER;
    } else {
      process.env.STORAGE_PROVIDER = originalEnv;
    }
  });

  test('returns local config by default', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.provider).toBe('local');
    expect(json.serverMode).toBe(false);
  });

  test('returns sqlite config when STORAGE_PROVIDER=sqlite', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    const res = await GET();
    const json = await res.json();
    expect(json.provider).toBe('sqlite');
    expect(json.serverMode).toBe(true);
  });

  test('returns postgres config when STORAGE_PROVIDER=postgres', async () => {
    process.env.STORAGE_PROVIDER = 'postgres';
    const res = await GET();
    const json = await res.json();
    expect(json.provider).toBe('postgres');
    expect(json.serverMode).toBe(true);
  });

  test('returns 500 on error', async () => {
    mockGetStorageConfig = () => {
      throw new Error('Config read failure');
    };
    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Config read failure');
  });
});
