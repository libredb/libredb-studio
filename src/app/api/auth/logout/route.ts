import { logout } from '@/lib/auth';
import { buildLogoutUrl } from '@/lib/oidc';
import { NextRequest, NextResponse } from 'next/server';

const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'local';

export async function POST(request: NextRequest) {
  await logout();

  if (authProvider === 'oidc') {
    const origin = new URL(request.url).origin;
    const returnTo = `${origin}/login`;
    const oidcLogoutUrl = buildLogoutUrl(returnTo);

    if (oidcLogoutUrl) {
      return NextResponse.json({ success: true, redirectUrl: oidcLogoutUrl });
    }
  }

  return NextResponse.json({ success: true });
}
