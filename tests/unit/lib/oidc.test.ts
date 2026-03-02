import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mapOIDCRole, getOIDCConfig, encryptState, decryptState, buildLogoutUrl } from '@/lib/oidc';
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
