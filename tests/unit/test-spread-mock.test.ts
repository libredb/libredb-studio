import { mock, test, expect } from 'bun:test';

mock.module('@/lib/storage/factory', async () => {
  const real = await import('@/lib/storage/factory');
  return {
    ...real,
    getStorageProvider: async () => null,
  };
});

import { getStorageConfig, getStorageProvider } from '@/lib/storage/factory';

test('getStorageConfig works', () => {
  const config = getStorageConfig();
  console.log('config:', config);
  expect(config.provider).toBe('local');
});

test('getStorageProvider is mocked', async () => {
  const p = await getStorageProvider();
  expect(p).toBeNull();
});
