import { describe, test, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { middleware } from '@/middleware';

// ─── JWT helpers ────────────────────────────────────────────────────────────

const JWT_SECRET = new TextEncoder().encode('test-jwt-secret-for-unit-tests-32ch');

async function createToken(role: string, expiresIn = '1h') {
  return await new SignJWT({ role, username: role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

function createNextRequest(pathname: string, token?: string): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const headers = new Headers();
  if (token) {
    headers.set('cookie', `auth-token=${token}`);
  }
  return new NextRequest(url, { headers });
}

function isRedirect(response: Response): boolean {
  return response.status === 307 || response.status === 308 || response.status === 302 || response.status === 301;
}

function getRedirectLocation(response: Response): string | null {
  return response.headers.get('location');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('middleware', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Public routes
  // ───────────────────────────────────────────────────────────────────────────

  describe('public routes', () => {
    test('/api/auth/login passes through without redirect', async () => {
      const req = createNextRequest('/api/auth/login');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('/api/db/health passes through without redirect', async () => {
      const req = createNextRequest('/api/db/health');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('/api/demo-connection passes through without redirect', async () => {
      const req = createNextRequest('/api/demo-connection');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('/_next/static/chunk.js passes through without redirect', async () => {
      const req = createNextRequest('/_next/static/chunk.js');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('/favicon.ico passes through without redirect', async () => {
      const req = createNextRequest('/favicon.ico');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Login page
  // ───────────────────────────────────────────────────────────────────────────

  describe('/login page', () => {
    test('allows access without token', async () => {
      const req = createNextRequest('/login');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('redirects to /admin with valid admin token', async () => {
      const token = await createToken('admin');
      const req = createNextRequest('/login', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain('/admin');
    });

    test('redirects to / with valid user token', async () => {
      const token = await createToken('user');
      const req = createNextRequest('/login', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      const location = getRedirectLocation(res)!;
      // Should redirect to root, not /admin
      expect(location).toContain('http://localhost:3000');
      expect(location).not.toContain('/admin');
      expect(location).not.toContain('/login');
    });

    test('allows access with invalid token', async () => {
      const req = createNextRequest('/login', 'invalid-token-garbage');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Protected routes
  // ───────────────────────────────────────────────────────────────────────────

  describe('protected routes', () => {
    test('redirects to /login without token', async () => {
      const req = createNextRequest('/');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain('/login');
    });

    test('allows access with valid token', async () => {
      const token = await createToken('user');
      const req = createNextRequest('/', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('redirects to /login with expired/invalid token', async () => {
      const req = createNextRequest('/', 'expired-or-invalid-token');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain('/login');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RBAC: /admin routes
  // ───────────────────────────────────────────────────────────────────────────

  describe('/admin RBAC', () => {
    test('allows admin role to access /admin', async () => {
      const token = await createToken('admin');
      const req = createNextRequest('/admin', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('redirects user role from /admin to /', async () => {
      const token = await createToken('user');
      const req = createNextRequest('/admin', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      const location = getRedirectLocation(res)!;
      expect(location).toContain('http://localhost:3000');
      expect(location).not.toContain('/admin');
      expect(location).not.toContain('/login');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // API routes with auth
  // ───────────────────────────────────────────────────────────────────────────

  describe('API routes', () => {
    test('/api/db/query with valid token passes through', async () => {
      const token = await createToken('user');
      const req = createNextRequest('/api/db/query', token);
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(false);
    });

    test('/api/db/query without token redirects to /login', async () => {
      const req = createNextRequest('/api/db/query');
      const res = await middleware(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain('/login');
    });
  });
});
