import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockLogin = mock(async () => {});

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

  test('returns 200 with role admin when admin password is provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { password: process.env.ADMIN_PASSWORD },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe('admin');
  });

  test('returns 200 with role user when user password is provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { password: process.env.USER_PASSWORD },
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
      body: { password: 'wrong-password' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe('Invalid password');
  });

  test('returns 401 when empty string password is provided', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { password: '' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe('Invalid password');
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

  test('calls login() with "admin" for admin password', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { password: process.env.ADMIN_PASSWORD },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('admin');
  });

  test('calls login() with "user" for user password', async () => {
    const req = createMockRequest('/api/auth/login', {
      method: 'POST',
      body: { password: process.env.USER_PASSWORD },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('user');
  });
});
