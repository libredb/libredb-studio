import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockGetSession = mock(async () => null as { role: string; username: string } | null);

mock.module('@/lib/auth', () => ({
  login: mock(async () => {}),
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  getSession: mockGetSession,
  logout: mock(async () => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { GET } = await import('@/app/api/auth/me/route');

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  beforeEach(() => {
    mockGetSession.mockClear();
  });

  test('returns 200 with authenticated true when session exists', async () => {
    mockGetSession.mockResolvedValueOnce({ role: 'admin', username: 'admin' });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.authenticated).toBe(true);
    expect(data.user).toEqual({ role: 'admin', username: 'admin' });
  });

  test('returns 401 with authenticated false when no session', async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET();
    const data = await parseResponseJSON<{ authenticated: boolean }>(res);

    expect(res.status).toBe(401);
    expect(data.authenticated).toBe(false);
  });

  test('returns admin role session data', async () => {
    mockGetSession.mockResolvedValueOnce({ role: 'admin', username: 'admin' });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(data.user.role).toBe('admin');
    expect(data.user.username).toBe('admin');
  });

  test('returns user role session data', async () => {
    mockGetSession.mockResolvedValueOnce({ role: 'user', username: 'user' });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(data.user.role).toBe('user');
    expect(data.user.username).toBe('user');
  });
});
