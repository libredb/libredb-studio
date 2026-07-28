import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getOIDCConfig, discoverProvider, generateAuthUrl, encryptState, getPublicOrigin } from "@/lib/oidc";
import { shouldMarkCookieSecure } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  try {
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    const origin = getPublicOrigin(request);
    const redirectUri = `${origin}/api/auth/oidc/callback`;

    const { url, state } = await generateAuthUrl(config, redirectUri, oidcConfig.scope);

    // Store PKCE state in signed cookie. The Secure flag follows the same rule
    // as the session cookie: a state cookie the browser drops takes the PKCE
    // verifier with it, and the callback fails on a missing state.
    const stateCookie = await encryptState(state);
    const cookieStore = await cookies();
    cookieStore.set("oidc-state", stateCookie, {
      httpOnly: true,
      secure: await shouldMarkCookieSecure(),
      sameSite: "lax",
      maxAge: 300, // 5 minutes
      path: "/",
    });

    return NextResponse.redirect(url.toString());
  } catch (error) {
    logger.error("OIDC login error", error, { route: "GET /api/auth/oidc/login" });
    const origin = getPublicOrigin(request);
    return NextResponse.redirect(`${origin}/login?error=oidc_config`);
  }
}
