import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@/lib/auth';
import {
  getOIDCConfig,
  discoverProvider,
  exchangeCode,
  decryptState,
  mapOIDCRole,
  getPublicOrigin,
} from '@/lib/oidc';

export async function GET(request: Request) {
  const origin = getPublicOrigin(request);

  try {
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get('oidc-state')?.value;

    if (!stateCookie) {
      return NextResponse.redirect(`${origin}/login?error=oidc_state_missing`);
    }

    // Decrypt and validate state
    let oidcState;
    try {
      oidcState = await decryptState(stateCookie);
    } catch {
      return NextResponse.redirect(`${origin}/login?error=oidc_state_invalid`);
    }

    // Exchange code for tokens
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    // Reconstruct callback URL with public origin for token exchange
    const internalUrl = new URL(request.url);
    const callbackUrl = new URL(
      `${internalUrl.pathname}${internalUrl.search}`,
      origin
    );

    const claims = await exchangeCode(
      config,
      callbackUrl,
      oidcState.code_verifier,
      oidcState.state,
      oidcState.nonce
    );

    if (!claims) {
      return NextResponse.redirect(`${origin}/login?error=oidc_no_claims`);
    }

    // Map role from claims
    const role = mapOIDCRole(
      claims as Record<string, unknown>,
      oidcConfig.roleClaim,
      oidcConfig.adminRoles
    );

    // Create local JWT session (same as password login)
    const username = claims.email || claims.preferred_username || claims.sub || role;
    await login(role, username);

    // Clean up state cookie
    cookieStore.delete('oidc-state');

    // Redirect based on role
    return NextResponse.redirect(
      `${origin}${role === 'admin' ? '/admin' : '/'}`
    );
  } catch (error) {
    console.error('OIDC callback error:', error);
    if (error instanceof Error && 'cause' in error) {
      console.error('OIDC error cause:', error.cause);
    }

    return NextResponse.redirect(`${origin}/login?error=oidc_failed`);
  }
}
