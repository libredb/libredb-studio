import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockLogout = mock(async () => {});

mock.module('@/lib/auth', () => ({
  login: mock(async () => {}),
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mockLogout,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/auth/logout/route');

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    mockLogout.mockClear();
  });

  test('returns 200 with success true', async () => {
    const res = await POST();
    const data = await parseResponseJSON<{ success: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test('calls logout() once', async () => {
    await POST();

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  test('multiple logouts all succeed', async () => {
    const res1 = await POST();
    const res2 = await POST();
    const res3 = await POST();

    const data1 = await parseResponseJSON<{ success: boolean }>(res1);
    const data2 = await parseResponseJSON<{ success: boolean }>(res2);
    const data3 = await parseResponseJSON<{ success: boolean }>(res3);

    expect(data1.success).toBe(true);
    expect(data2.success).toBe(true);
    expect(data3.success).toBe(true);
    expect(mockLogout).toHaveBeenCalledTimes(3);
  });
});
