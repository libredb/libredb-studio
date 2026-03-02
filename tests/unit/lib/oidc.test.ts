import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// ─── Mock openid-client before importing oidc.ts ────────────────────────────

const mockDiscoveryFn = mock(async () => 'mock-oidc-config' as unknown);
const mockRandomPKCECodeVerifier = mock(() => 'mock-code-verifier');
const mockCalculatePKCECodeChallenge = mock(async () => 'mock-code-challenge');
const mockRandomState = mock(() => 'mock-state-value');
const mockRandomNonce = mock(() => 'mock-nonce-value');
const mockBuildAuthorizationUrl = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_config: unknown, _params: Record<string, string>) =>
    new URL('https://provider.com/authorize?state=mock-state-value')
);
const mockClaims = mock(() => ({ sub: 'user-123', email: 'user@test.com' }) as Record<string, unknown> | undefined);
const mockAuthorizationCodeGrant = mock(async () => ({
  claims: mockClaims,
}));
const mockClientSecretPost = mock(() => 'client-auth-method');

mock.module('openid-client', () => ({
  discovery: mockDiscoveryFn,
  randomPKCECodeVerifier: mockRandomPKCECodeVerifier,
  calculatePKCECodeChallenge: mockCalculatePKCECodeChallenge,
  randomState: mockRandomState,
  randomNonce: mockRandomNonce,
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
  authorizationCodeGrant: mockAuthorizationCodeGrant,
  ClientSecretPost: mockClientSecretPost,
}));

// ─── Dynamic import after mocking ───────────────────────────────────────────

const {
  mapOIDCRole, getOIDCConfig, encryptState, decryptState, buildLogoutUrl,
  discoverProvider, generateAuthUrl, exchangeCode, resetDiscoveryCache,
} = await import('@/lib/oidc');
import type { OIDCState } from '@/lib/oidc';

// ─── mapOIDCRole ────────────────────────────────────────────────────────────

describe('mapOIDCRole', () => {
  test('returns "user" when roleClaim is empty', () => {
    expect(mapOIDCRole({ roles: 'admin' }, '', ['admin'])).toBe('user');
  });

  test('returns "user" when claim is missing', () => {
    expect(mapOIDCRole({}, 'roles', ['admin'])).toBe('user');
  });

  test('returns "admin" for flat string claim match', () => {
    expect(mapOIDCRole({ role: 'admin' }, 'role', ['admin'])).toBe('admin');
  });

  test('returns "user" for flat string claim no match', () => {
    expect(mapOIDCRole({ role: 'viewer' }, 'role', ['admin'])).toBe('user');
  });

  test('returns "admin" for array claim match', () => {
    const claims = { roles: ['viewer', 'admin', 'editor'] };
    expect(mapOIDCRole(claims, 'roles', ['admin'])).toBe('admin');
  });

  test('returns "user" for array claim no match', () => {
    const claims = { roles: ['viewer', 'editor'] };
    expect(mapOIDCRole(claims, 'roles', ['admin'])).toBe('user');
  });

  test('supports dot-notation for nested claims', () => {
    const claims = { realm_access: { roles: ['admin'] } };
    expect(mapOIDCRole(claims, 'realm_access.roles', ['admin'])).toBe('admin');
  });

  test('returns "user" for nested claim path not found', () => {
    const claims = { realm_access: {} };
    expect(mapOIDCRole(claims, 'realm_access.roles', ['admin'])).toBe('user');
  });

  test('returns "user" when nested path traverses non-object', () => {
    const claims = { realm_access: 'string' };
    expect(mapOIDCRole(claims, 'realm_access.roles', ['admin'])).toBe('user');
  });

  test('case-insensitive matching', () => {
    expect(mapOIDCRole({ role: 'Admin' }, 'role', ['admin'])).toBe('admin');
    expect(mapOIDCRole({ role: 'ADMIN' }, 'role', ['admin'])).toBe('admin');
  });

  test('supports multiple admin role values', () => {
    expect(mapOIDCRole({ role: 'superadmin' }, 'role', ['admin', 'superadmin'])).toBe('admin');
    expect(mapOIDCRole({ role: 'admin' }, 'role', ['admin', 'superadmin'])).toBe('admin');
    expect(mapOIDCRole({ role: 'viewer' }, 'role', ['admin', 'superadmin'])).toBe('user');
  });

  test('handles null value in claim path', () => {
    const claims = { realm_access: null };
    expect(mapOIDCRole(claims, 'realm_access.roles', ['admin'])).toBe('user');
  });
});

// ─── getOIDCConfig ──────────────────────────────────────────────────────────

describe('getOIDCConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://example.auth0.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.OIDC_SCOPE = '';
    process.env.OIDC_ROLE_CLAIM = '';
    process.env.OIDC_ADMIN_ROLES = '';
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  test('returns config with all required fields', () => {
    const config = getOIDCConfig();
    expect(config.issuer).toBe('https://example.auth0.com');
    expect(config.clientId).toBe('test-client-id');
    expect(config.clientSecret).toBe('test-client-secret');
  });

  test('uses default scope when not set', () => {
    const config = getOIDCConfig();
    expect(config.scope).toBe('openid profile email');
  });

  test('uses custom scope when set', () => {
    process.env.OIDC_SCOPE = 'openid email';
    const config = getOIDCConfig();
    expect(config.scope).toBe('openid email');
  });

  test('parses admin roles from comma-separated string', () => {
    process.env.OIDC_ADMIN_ROLES = 'admin, superadmin, root';
    const config = getOIDCConfig();
    expect(config.adminRoles).toEqual(['admin', 'superadmin', 'root']);
  });

  test('defaults admin roles to ["admin"]', () => {
    const config = getOIDCConfig();
    expect(config.adminRoles).toEqual(['admin']);
  });

  test('throws when OIDC_ISSUER is missing', () => {
    delete process.env.OIDC_ISSUER;
    expect(() => getOIDCConfig()).toThrow('OIDC_ISSUER');
  });

  test('throws when OIDC_CLIENT_ID is missing', () => {
    delete process.env.OIDC_CLIENT_ID;
    expect(() => getOIDCConfig()).toThrow('OIDC_CLIENT_ID');
  });

  test('throws when OIDC_CLIENT_SECRET is missing', () => {
    delete process.env.OIDC_CLIENT_SECRET;
    expect(() => getOIDCConfig()).toThrow('OIDC_CLIENT_SECRET');
  });
});

// ─── encryptState / decryptState ────────────────────────────────────────────

describe('encryptState / decryptState', () => {
  const testState: OIDCState = {
    code_verifier: 'test-code-verifier-abc123',
    state: 'test-state-xyz789',
    nonce: 'test-nonce-def456',
  };

  test('round-trips state correctly', async () => {
    const encrypted = await encryptState(testState);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await decryptState(encrypted);
    expect(decrypted.code_verifier).toBe(testState.code_verifier);
    expect(decrypted.state).toBe(testState.state);
    expect(decrypted.nonce).toBe(testState.nonce);
  });

  test('fails to decrypt tampered token', async () => {
    const encrypted = await encryptState(testState);
    const tampered = encrypted.slice(0, -5) + 'XXXXX';
    await expect(decryptState(tampered)).rejects.toThrow();
  });

  test('throws when JWT_SECRET is not set', async () => {
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    await expect(encryptState(testState)).rejects.toThrow('JWT_SECRET is required');

    process.env.JWT_SECRET = savedSecret;
  });
});

// ─── buildLogoutUrl ──────────────────────────────────────────────────────────

describe('buildLogoutUrl', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://libredb.eu.auth0.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  test('builds Auth0 logout URL with /v2/logout', () => {
    const url = buildLogoutUrl('http://localhost:3000/login');
    expect(url).not.toBeNull();
    expect(url).toContain('/v2/logout');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('returnTo=http%3A%2F%2Flocalhost%3A3000%2Flogin');
  });

  test('builds generic OIDC logout URL for non-Auth0 issuers', () => {
    process.env.OIDC_ISSUER = 'https://keycloak.example.com/realms/myrealm';
    const url = buildLogoutUrl('http://localhost:3000/login');
    expect(url).not.toBeNull();
    expect(url).toContain('/protocol/openid-connect/logout');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('post_logout_redirect_uri=');
  });

  test('returns null when OIDC config is missing', () => {
    delete process.env.OIDC_ISSUER;
    const url = buildLogoutUrl('http://localhost:3000/login');
    expect(url).toBeNull();
  });
});

// ─── discoverProvider ────────────────────────────────────────────────────────

describe('discoverProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://example.auth0.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    mockDiscoveryFn.mockClear();
    mockClientSecretPost.mockClear();
    resetDiscoveryCache();
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    resetDiscoveryCache();
  });

  test('calls client.discovery with correct parameters', async () => {
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);
    const args = mockDiscoveryFn.mock.calls[0] as unknown as [URL, string, string, unknown];
    expect(args[0].toString()).toBe('https://example.auth0.com/');
    expect(args[1]).toBe('test-client-id');
    expect(args[2]).toBe('test-client-secret');
  });

  test('calls ClientSecretPost with client secret', async () => {
    await discoverProvider();

    expect(mockClientSecretPost).toHaveBeenCalledWith('test-client-secret');
  });

  test('returns the discovered configuration', async () => {
    const config = await discoverProvider();
    expect(config as unknown).toBe('mock-oidc-config');
  });

  test('caches configuration on second call', async () => {
    await discoverProvider();
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);
  });

  test('re-discovers after resetDiscoveryCache', async () => {
    await discoverProvider();
    resetDiscoveryCache();
    await discoverProvider();

    expect(mockDiscoveryFn).toHaveBeenCalledTimes(2);
  });

  test('uses provided oidcConfig when given', async () => {
    const customConfig = {
      issuer: 'https://custom.provider.com',
      clientId: 'custom-id',
      clientSecret: 'custom-secret',
      scope: 'openid',
      roleClaim: '',
      adminRoles: ['admin'],
    };

    await discoverProvider(customConfig);

    const args = mockDiscoveryFn.mock.calls[0] as unknown as [URL, string, string, unknown];
    expect(args[0].toString()).toBe('https://custom.provider.com/');
    expect(args[1]).toBe('custom-id');
    expect(args[2]).toBe('custom-secret');
  });
});

// ─── generateAuthUrl ─────────────────────────────────────────────────────────

describe('generateAuthUrl', () => {
  beforeEach(() => {
    mockRandomPKCECodeVerifier.mockClear();
    mockCalculatePKCECodeChallenge.mockClear();
    mockRandomState.mockClear();
    mockRandomNonce.mockClear();
    mockBuildAuthorizationUrl.mockClear();
  });

  test('returns URL and state with PKCE values', async () => {
    const result = await generateAuthUrl(
      'mock-config' as never,
      'http://localhost:3000/callback',
      'openid profile email'
    );

    expect(result.url).toBeInstanceOf(URL);
    expect(result.state.code_verifier).toBe('mock-code-verifier');
    expect(result.state.state).toBe('mock-state-value');
    expect(result.state.nonce).toBe('mock-nonce-value');
  });

  test('calls PKCE helper functions', async () => {
    await generateAuthUrl('mock-config' as never, 'http://localhost:3000/callback', 'openid');

    expect(mockRandomPKCECodeVerifier).toHaveBeenCalledTimes(1);
    expect(mockCalculatePKCECodeChallenge).toHaveBeenCalledWith('mock-code-verifier');
    expect(mockRandomState).toHaveBeenCalledTimes(1);
    expect(mockRandomNonce).toHaveBeenCalledTimes(1);
  });

  test('passes correct parameters to buildAuthorizationUrl', async () => {
    await generateAuthUrl(
      'mock-config' as never,
      'http://localhost:3000/callback',
      'openid profile'
    );

    expect(mockBuildAuthorizationUrl).toHaveBeenCalledTimes(1);
    const [config, params] = mockBuildAuthorizationUrl.mock.calls[0];
    expect(config).toBe('mock-config');
    expect(params).toEqual({
      redirect_uri: 'http://localhost:3000/callback',
      scope: 'openid profile',
      code_challenge: 'mock-code-challenge',
      code_challenge_method: 'S256',
      state: 'mock-state-value',
      nonce: 'mock-nonce-value',
      prompt: 'login',
    });
  });
});

// ─── exchangeCode ────────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  beforeEach(() => {
    mockAuthorizationCodeGrant.mockClear();
    mockClaims.mockClear();
    mockClaims.mockReturnValue({ sub: 'user-123', email: 'user@test.com' });
  });

  test('exchanges code and returns claims', async () => {
    const result = await exchangeCode(
      'mock-config' as never,
      new URL('http://localhost:3000/callback?code=abc&state=xyz'),
      'verifier',
      'state',
      'nonce'
    );

    expect(result).toEqual({ sub: 'user-123', email: 'user@test.com' });
  });

  test('calls authorizationCodeGrant with correct parameters', async () => {
    const callbackUrl = new URL('http://localhost:3000/callback?code=abc');

    await exchangeCode('mock-config' as never, callbackUrl, 'my-verifier', 'my-state', 'my-nonce');

    expect(mockAuthorizationCodeGrant).toHaveBeenCalledWith(
      'mock-config',
      callbackUrl,
      {
        pkceCodeVerifier: 'my-verifier',
        expectedState: 'my-state',
        expectedNonce: 'my-nonce',
        idTokenExpected: true,
      }
    );
  });

  test('returns null when claims() returns null/undefined', async () => {
    mockClaims.mockReturnValue(undefined);

    const result = await exchangeCode(
      'mock-config' as never,
      new URL('http://localhost:3000/callback?code=abc'),
      'verifier',
      'state',
      'nonce'
    );

    expect(result).toBeNull();
  });
});

// ─── resetDiscoveryCache ─────────────────────────────────────────────────────

describe('resetDiscoveryCache', () => {
  beforeEach(() => {
    mockDiscoveryFn.mockClear();
    process.env.OIDC_ISSUER = 'https://example.auth0.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(() => {
    resetDiscoveryCache();
  });

  test('clears cache so next discover call hits provider', async () => {
    // First call populates cache
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);

    // Second call uses cache
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(1);

    // Reset and call again
    resetDiscoveryCache();
    await discoverProvider();
    expect(mockDiscoveryFn).toHaveBeenCalledTimes(2);
  });
});
