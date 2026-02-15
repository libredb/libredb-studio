import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ============================================================================
// Mock State
// ============================================================================

let mockSignResult = 'mock-jwt-token';
let mockVerifyResult: { payload: { role: string; username: string } } | null = {
  payload: { role: 'admin', username: 'admin' },
};
let mockCookieStore: Record<string, { value: string } | undefined> = {};
let mockSetCalls: Array<{ name: string; value: string; opts: unknown }> = [];
let mockDeleteCalls: string[] = [];

// ============================================================================
// Module Mocks (must be before await import)
// ============================================================================

mock.module('jose', () => ({
  SignJWT: function (payload: Record<string, unknown>) {
    return {
      setProtectedHeader: function () {
        return this;
      },
      setIssuedAt: function () {
        return this;
      },
      setExpirationTime: function () {
        return this;
      },
      sign: async function () {
        return mockSignResult;
      },
    };
  },
  jwtVerify: async function () {
    if (mockVerifyResult === null) throw new Error('Invalid token');
    return mockVerifyResult;
  },
}));

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
// Tests
// ============================================================================

describe('auth', () => {
  beforeEach(() => {
    mockSignResult = 'mock-jwt-token';
    mockVerifyResult = { payload: { role: 'admin', username: 'admin' } };
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
      expect(token).toBe('mock-jwt-token');
    });

    test('accepts admin role', async () => {
      mockSignResult = 'admin-token';
      const token = await signJWT({ role: 'admin', username: 'admin' });
      expect(token).toBe('admin-token');
    });

    test('accepts user role', async () => {
      mockSignResult = 'user-token';
      const token = await signJWT({ role: 'user', username: 'user' });
      expect(token).toBe('user-token');
    });
  });

  // --------------------------------------------------------------------------
  // verifyJWT()
  // --------------------------------------------------------------------------

  describe('verifyJWT()', () => {
    test('valid token returns UserPayload', async () => {
      mockVerifyResult = { payload: { role: 'admin', username: 'admin' } };
      const payload = await verifyJWT('valid-token');
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe('admin');
      expect(payload!.username).toBe('admin');
    });

    test('invalid token returns null', async () => {
      mockVerifyResult = null;
      const payload = await verifyJWT('invalid-token');
      expect(payload).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSession()
  // --------------------------------------------------------------------------

  describe('getSession()', () => {
    test('returns payload when auth-token cookie exists', async () => {
      mockCookieStore['auth-token'] = { value: 'some-token' };
      mockVerifyResult = { payload: { role: 'user', username: 'user' } };

      const session = await getSession();
      expect(session).not.toBeNull();
      expect(session!.role).toBe('user');
      expect(session!.username).toBe('user');
    });

    test('returns null when no cookie', async () => {
      mockCookieStore = {};
      const session = await getSession();
      expect(session).toBeNull();
    });

    test('returns null when token is invalid', async () => {
      mockCookieStore['auth-token'] = { value: 'bad-token' };
      mockVerifyResult = null;

      const session = await getSession();
      expect(session).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // login()
  // --------------------------------------------------------------------------

  describe('login()', () => {
    test('sets auth-token cookie with correct options', async () => {
      await login('admin');

      expect(mockSetCalls).toHaveLength(1);
      expect(mockSetCalls[0].name).toBe('auth-token');
      expect(mockSetCalls[0].value).toBe('mock-jwt-token');

      const opts = mockSetCalls[0].opts as Record<string, unknown>;
      expect(opts.sameSite).toBe('lax');
      expect(opts.maxAge).toBe(60 * 60 * 24);
      expect(opts.path).toBe('/');
    });

    test('cookie has httpOnly flag', async () => {
      await login('user');

      expect(mockSetCalls).toHaveLength(1);
      const opts = mockSetCalls[0].opts as Record<string, unknown>;
      expect(opts.httpOnly).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // logout()
  // --------------------------------------------------------------------------

  describe('logout()', () => {
    test('deletes auth-token cookie', async () => {
      mockCookieStore['auth-token'] = { value: 'token-to-remove' };

      await logout();

      expect(mockDeleteCalls).toHaveLength(1);
      expect(mockDeleteCalls[0]).toBe('auth-token');
    });
  });
});
