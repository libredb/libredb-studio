import { logout } from '@/lib/auth';
import { buildLogoutUrl, getPublicOrigin } from '@/lib/oidc';
import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api/errors';

export async function POST(request: NextRequest) {
  try {
    await logout();

    const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'local';
    if (authProvider === 'oidc') {
      const origin = getPublicOrigin(request);
      const returnTo = `${origin}/login`;
      const oidcLogoutUrl = buildLogoutUrl(returnTo);

      if (oidcLogoutUrl) {
        return NextResponse.json({ success: true, redirectUrl: oidcLogoutUrl });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return createErrorResponse(error, { route: 'POST /api/auth/logout' });
  }
}
