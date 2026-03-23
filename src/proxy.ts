import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { logger } from '@/lib/logger';

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    // Development fallback - only for local development
    return new TextEncoder().encode('development-fallback-secret-32ch');
  }

  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  return new TextEncoder().encode(secret);
}

// Lazy-initialized to prevent module-level crash if JWT_SECRET is misconfigured.
// A module-level throw would block ALL requests (including health check).
let _jwtSecret: Uint8Array | null = null;
function jwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    _jwtSecret = getJwtSecret();
  }
  return _jwtSecret;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isStaticAsset = /\.[a-z0-9]+$/i.test(pathname);

  const token = request.cookies.get('auth-token')?.value;

  // If accessing /login with a valid token, redirect authenticated users
  if (pathname.startsWith('/login')) {
    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwtSecret());
        const role = payload.role as string;
        // Redirect authenticated users based on their role
        return NextResponse.redirect(new URL(role === 'admin' ? '/admin' : '/', request.url));
      } catch {
        // Invalid token, allow access to login page
        logger.debug('Invalid token on login page, allowing access', { route: 'proxy' });
        return NextResponse.next();
      }
    }
    // No token, allow access to login page
    return NextResponse.next();
  }

  // Allow public routes
  if (
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    isStaticAsset ||
    pathname === '/favicon.ico' ||
    // Health check endpoint for load balancers (Render, K8s, etc.)
    pathname === '/api/db/health' ||
    // Demo connection endpoint (public for initial load)
    pathname === '/api/demo-connection' ||
    // Storage config endpoint (public, returns only mode info)
    pathname === '/api/storage/config'
  ) {
    return NextResponse.next();
  }

  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    const role = payload.role as string;

    // RBAC: /admin only for admin
    if (pathname.startsWith('/admin') && role !== 'admin') {
      return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next();
  } catch {
    logger.warn('JWT verification failed, redirecting to login', { route: 'proxy' });
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (auth endpoints)
     * - api/db/health (health check for load balancers)
     * - api/demo-connection (demo database connection - public)
     * - api/storage/config (storage mode discovery - public)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api/auth|api/db/health|api/demo-connection|api/storage/config|_next/static|_next/image|.*\\..*).*)',
  ],
};
