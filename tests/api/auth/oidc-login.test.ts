import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Mock dependencies ─────────────────────────────────────────────────────

const mockGetOIDCConfig = mock(() => ({
  issuer: 'https://example.auth0.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scope: 'openid profile email',
  roleClaim: '',
  adminRoles: ['admin'],
}));

const mockDiscoverProvider = mock(async () => 'mock-config');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockGenerateAuthUrl = mock(async (_config: unknown, _redirectUri: string, _scope: string) => ({
  url: new URL('https://example.auth0.com/authorize?state=abc&code_challenge=xyz'),
  state: {
    code_verifier: 'test-verifier',
    state: 'test-state',
    nonce: 'test-nonce',
  },
}));

const mockEncryptState = mock(async () => 'encrypted-state-token');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockCookieSet = mock((_name: string, _value: string, _options?: Record<string, unknown>) => {});

const mockGetPublicOrigin = mock(
  (req: Request) => new URL(req.url).origin
);

mock.module('@/lib/oidc', () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mockGenerateAuthUrl,
  encryptState: mockEncryptState,
  decryptState: mock(async () => ({})),
  exchangeCode: mock(async () => ({})),
  mapOIDCRole: mock(() => 'user'),
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mockGetPublicOrigin,
}));

const mockCookieStore = {
  get: mock(() => undefined),
  set: mockCookieSet,
  delete: mock(() => {}),
};

mock.module('next/headers', () => ({
  cookies: mock(async () => mockCookieStore),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { GET } = await import('@/app/api/auth/oidc/login/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/auth/oidc/login', () => {
  beforeEach(() => {
    mockGetOIDCConfig.mockClear();
    mockDiscoverProvider.mockClear();
    mockGenerateAuthUrl.mockClear();
    mockEncryptState.mockClear();
    mockCookieSet.mockClear();
    mockGetPublicOrigin.mockClear();
    mockGetPublicOrigin.mockImplementation((req: Request) => new URL(req.url).origin);
  });

  test('redirects to OIDC provider authorization URL', async () => {
    const req = new Request('http://localhost:3000/api/auth/oidc/login');
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toBe('https://example.auth0.com/authorize?state=abc&code_challenge=xyz');
  });

  test('sets oidc-state cookie', async () => {
    const req = new Request('http://localhost:3000/api/auth/oidc/login');
    await GET(req);

    expect(mockCookieSet).toHaveBeenCalledTimes(1);
    const [name, value, options] = mockCookieSet.mock.calls[0];
    expect(name).toBe('oidc-state');
    expect(value).toBe('encrypted-state-token');
    expect(options!.httpOnly).toBe(true);
    expect(options!.maxAge).toBe(300);
  });

  test('uses correct redirect URI based on request origin', async () => {
    const req = new Request('https://app.example.com/api/auth/oidc/login');
    await GET(req);

    expect(mockGenerateAuthUrl).toHaveBeenCalledTimes(1);
    const [, redirectUri] = mockGenerateAuthUrl.mock.calls[0];
    expect(redirectUri).toBe('https://app.example.com/api/auth/oidc/callback');
  });

  test('uses public origin from getPublicOrigin for redirect_uri', async () => {
    mockGetPublicOrigin.mockReturnValue('https://app.libredb.org');

    const req = new Request('http://0.0.0.0:10000/api/auth/oidc/login');
    await GET(req);

    expect(mockGenerateAuthUrl).toHaveBeenCalledTimes(1);
    const [, redirectUri] = mockGenerateAuthUrl.mock.calls[0];
    expect(redirectUri).toBe('https://app.libredb.org/api/auth/oidc/callback');
  });

  test('redirects to /login?error=oidc_config when config fails', async () => {
    mockGetOIDCConfig.mockImplementationOnce(() => {
      throw new Error('Missing OIDC config');
    });

    const req = new Request('http://localhost:3000/api/auth/oidc/login');
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('/login?error=oidc_config');
  });
});
