import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ============================================================================
// Mock State — only mock next/headers (cookies), NOT jose
// jose is used for real JWT sign/verify with JWT_SECRET from setup.ts
// ============================================================================

let mockCookieStore: Record<string, { value: string } | undefined> = {};
let mockSetCalls: Array<{ name: string; value: string; opts: unknown }> = [];
let mockDeleteCalls: string[] = [];

// ============================================================================
// Module Mocks — only next/headers
// ============================================================================

mock.module('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => mockCookieStore[name],
    set: (name: string, value: string, opts: unknown) => {
      mockSetCalls.push({ name, value, opts });
      mockCookieStore[name] = { value };
    },
    delete: (name: string) => {
      mockDeleteCalls.push(name);
      delete mockCookieStore[name];
    },
  }),
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

const { signJWT, verifyJWT, getSession, login, logout } = await import('@/lib/auth');

// ============================================================================
// Tests — use real jose sign/verify with JWT_SECRET from tests/setup.ts
// ============================================================================

describe('auth', () => {
  beforeEach(() => {
    mockCookieStore = {};
    mockSetCalls = [];
    mockDeleteCalls = [];
  });

  // --------------------------------------------------------------------------
  // signJWT()
  // --------------------------------------------------------------------------

  describe('signJWT()', () => {
    test('returns a token string', async () => {
      const token = await signJWT({ role: 'admin', username: 'admin' });
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      // Real JWT has 3 dot-separated parts
      expect(token.split('.').length).toBe(3);
    });

    test('accepts admin role', async () => {
      const token = await signJWT({ role: 'admin', username: 'admin' });
      expect(typeof token).toBe('string');
    });

    test('accepts user role', async () => {
      const token = await signJWT({ role: 'user', username: 'user' });
      expect(typeof token).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // verifyJWT()
  // --------------------------------------------------------------------------

  describe('verifyJWT()', () => {
    test('valid token returns UserPayload', async () => {
      const token = await signJWT({ role: 'admin', username: 'admin' });
      const payload = await verifyJWT(token);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe('admin');
      expect(payload!.username).toBe('admin');
    });

    test('invalid token returns null', async () => {
      const payload = await verifyJWT('invalid-token-string');
      expect(payload).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSession()
  // --------------------------------------------------------------------------

  describe('getSession()', () => {
    test('returns payload when auth-token cookie exists', async () => {
      const token = await signJWT({ role: 'user', username: 'user' });
      mockCookieStore['auth-token'] = { value: token };

      const session = await getSession();
      expect(session).not.toBeNull();
      expect(session!.role).toBe('user');
      expect(session!.username).toBe('user');
    });

    test('returns null when no cookie', async () => {
      const session = await getSession();
      expect(session).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // login()
  // --------------------------------------------------------------------------

  describe('login()', () => {
    test('sets auth-token cookie with admin role', async () => {
      await login('admin', 'admin');
      expect(mockSetCalls.length).toBeGreaterThan(0);
      expect(mockSetCalls[0].name).toBe('auth-token');
      // Verify the token is valid
      const token = mockSetCalls[0].value;
      const payload = await verifyJWT(token);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe('admin');
    });

    test('sets auth-token cookie with user role', async () => {
      await login('user', 'user');
      expect(mockSetCalls.length).toBeGreaterThan(0);
      const token = mockSetCalls[0].value;
      const payload = await verifyJWT(token);
      expect(payload!.role).toBe('user');
    });
  });

  // --------------------------------------------------------------------------
  // logout()
  // --------------------------------------------------------------------------

  describe('logout()', () => {
    test('deletes auth-token cookie', async () => {
      await logout();
      expect(mockDeleteCalls).toContain('auth-token');
    });
  });
});
