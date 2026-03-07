import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  getOIDCConfig,
  discoverProvider,
  generateAuthUrl,
  encryptState,
  getPublicOrigin,
} from '@/lib/oidc';

export async function GET(request: Request) {
  try {
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    const origin = getPublicOrigin(request);
    const redirectUri = `${origin}/api/auth/oidc/callback`;

    const { url, state } = await generateAuthUrl(
      config,
      redirectUri,
      oidcConfig.scope
    );

    // Store PKCE state in signed cookie
    const stateCookie = await encryptState(state);
    const cookieStore = await cookies();
    cookieStore.set('oidc-state', stateCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300, // 5 minutes
      path: '/',
    });

    return NextResponse.redirect(url.toString());
  } catch (error) {
    console.error('OIDC login error:', error);
    const origin = getPublicOrigin(request);
    return NextResponse.redirect(`${origin}/login?error=oidc_config`);
  }
}
