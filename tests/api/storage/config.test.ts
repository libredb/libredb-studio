import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GET } from '@/app/api/storage/config/route';

describe('GET /api/storage/config', () => {
  const originalEnv = process.env.STORAGE_PROVIDER;

  beforeEach(() => {
    delete process.env.STORAGE_PROVIDER;
  });

  afterEach(() => {
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
});
