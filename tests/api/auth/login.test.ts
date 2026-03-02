import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockLogin = mock(async (_role: string, _email?: string) => {});

mock.module('@/lib/auth', () => ({
  login: mockLogin,
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mock(async () => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/auth/login/route');

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  beforeEach(() => {
    mockLogin.mockClear();
  });

  test('returns 200 with role admin when admin credentials are provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@libredb.org', password: 'LibreDB.2026' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe('admin');
  });

  test('returns 200 with role user when user credentials are provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'user@libredb.org', password: 'LibreDB.2026' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe('user');
  });

  test('returns 401 when wrong password is provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@libredb.org', password: 'wrong-password' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe('Invalid email or password');
  });

  test('returns 401 when wrong email is provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'unknown@example.com', password: 'LibreDB.2026' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe('Invalid email or password');
  });

  test('returns 401 when empty credentials are provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: '', password: '' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe('Invalid email or password');
  });

  test('returns 500 when body is not valid JSON', async () => {
    const req = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.message).toBe('An error occurred');
  });

  test('returns 500 when body is empty', async () => {
    const req = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.message).toBe('An error occurred');
  });

  test('calls login() with role and email for admin', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@libredb.org', password: 'LibreDB.2026' },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('admin', 'admin@libredb.org');
  });

  test('calls login() with role and email for user', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'user@libredb.org', password: 'LibreDB.2026' },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('user', 'user@libredb.org');
  });
});
