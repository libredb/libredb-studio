import { logout } from '@/lib/auth';
import { buildLogoutUrl, getPublicOrigin } from '@/lib/oidc';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
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
}
