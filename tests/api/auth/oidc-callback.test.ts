import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Mock dependencies ─────────────────────────────────────────────────────

const mockDecryptState = mock(async () => ({
  code_verifier: 'test-verifier',
  state: 'test-state',
  nonce: 'test-nonce',
}));

const mockGetOIDCConfig = mock(() => ({
  issuer: 'https://example.auth0.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scope: 'openid profile email',
  roleClaim: 'roles',
  adminRoles: ['admin'],
}));

const mockDiscoverProvider = mock(async () => 'mock-config');

const defaultClaims = {
  sub: 'user-123',
  email: 'user@example.com',
  preferred_username: 'testuser',
};

const mockExchangeCode = mock(async () => ({ ...defaultClaims }) as Record<string, unknown> | null);

const mockMapOIDCRole = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_claims: Record<string, unknown>, _roleClaim: string, _adminRoles: string[]) =>
    'user' as 'admin' | 'user'
);

mock.module('@/lib/oidc', () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ''),
  decryptState: mockDecryptState,
  exchangeCode: mockExchangeCode,
  mapOIDCRole: mockMapOIDCRole,
  resetDiscoveryCache: mock(() => {}),
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockLogin = mock(async (_role: string, _username?: string) => {});

mock.module('@/lib/auth', () => ({
  login: mockLogin,
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mock(async () => {}),
}));

const mockCookieGet = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_name: string) => ({ value: 'encrypted-state-cookie' }) as { value: string } | undefined
);

const mockCookieStore = {
  get: mockCookieGet,
  set: mock(() => {}),
  delete: mock(() => {}),
};

mock.module('next/headers', () => ({
  cookies: mock(async () => mockCookieStore),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { GET } = await import('@/app/api/auth/oidc/callback/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/auth/oidc/callback', () => {
  beforeEach(() => {
    mockDecryptState.mockClear();
    mockGetOIDCConfig.mockClear();
    mockDiscoverProvider.mockClear();
    mockExchangeCode.mockClear();
    mockMapOIDCRole.mockClear();
    mockLogin.mockClear();
    mockCookieGet.mockClear();
    mockCookieStore.delete.mockClear();

    // Reset defaults
    mockCookieGet.mockReturnValue({ value: 'encrypted-state-cookie' });
    mockMapOIDCRole.mockReturnValue('user');
    mockExchangeCode.mockImplementation(async () => ({ ...defaultClaims }));
  });

  test('exchanges code and creates local session', async () => {
    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(mockDecryptState).toHaveBeenCalledWith('encrypted-state-cookie');
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('user', 'user@example.com');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/');
  });

  test('redirects admin to /admin', async () => {
    mockMapOIDCRole.mockReturnValue('admin');

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(mockLogin).toHaveBeenCalledWith('admin', 'user@example.com');
    expect(res.headers.get('location')).toContain('/admin');
  });

  test('deletes oidc-state cookie after success', async () => {
    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    await GET(req);

    expect(mockCookieStore.delete).toHaveBeenCalledWith('oidc-state');
  });

  test('redirects to /login?error=oidc_state_missing when no cookie', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=oidc_state_missing');
  });

  test('redirects to /login?error=oidc_state_invalid when decrypt fails', async () => {
    mockDecryptState.mockImplementationOnce(async () => {
      throw new Error('Invalid token');
    });

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=oidc_state_invalid');
  });

  test('redirects to /login?error=oidc_no_claims when no claims', async () => {
    mockExchangeCode.mockImplementationOnce(async () => null);

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=oidc_no_claims');
  });

  test('redirects to /login?error=oidc_failed on exchange error', async () => {
    mockExchangeCode.mockImplementationOnce(async () => {
      throw new Error('Token exchange failed');
    });

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=oidc_failed');
  });

  test('uses sub as username fallback when email is missing', async () => {
    mockExchangeCode.mockImplementationOnce(async () => ({
      sub: 'user-123',
    }));

    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    await GET(req);

    expect(mockLogin).toHaveBeenCalledWith('user', 'user-123');
  });

  test('passes claims to mapOIDCRole with correct config', async () => {
    const req = new Request(
      'http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state'
    );
    await GET(req);

    expect(mockMapOIDCRole).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-123', email: 'user@example.com' }),
      'roles',
      ['admin']
    );
  });
});
